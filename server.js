import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import WebSocket, { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const authConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
const JUPITER_API_KEY = (process.env.JUPITER_API_KEY || "").trim();
const databaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);

const supabaseAdmin = databaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "12kb" }));

const waitlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a little while." }
});
const geckoLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Market-data request limit reached. Please wait a moment." }
});

app.get("/api/config.js", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("application/javascript").send(
    "window.ALPHA_SUPABASE_CONFIG = " +
    JSON.stringify({ url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY }) + ";"
  );
});

app.get("/api/health", async (_req, res) => {
  let waitlistConnected = false;
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from("waitlist").select("id", { head: true }).limit(1);
    waitlistConnected = !error;
    if (error) console.error("waitlist health check failed:", error.message);
  }
  res.json({
    ok: true, service: "alpha-api", authConfigured, databaseConfigured,
    waitlistConnected,
    adminAccessConfigured: Boolean(ADMIN_EMAIL && supabaseAdmin),
  });
});

// Mint short-lived, single-use WebSocket tickets only for the configured admin.
const pumpTickets = new Map();
app.post("/api/pump-ticket", async (req, res) => {
  if (!ADMIN_EMAIL || !supabaseAdmin) return res.status(503).json({ error: "Administrator access is not configured." });
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Admin session required." });
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(match[1]);
    if (error || !data?.user || (data.user.email || "").trim().toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: "Administrator access required." });
    }
    const ticket = randomBytes(24).toString("base64url");
    pumpTickets.set(ticket, Date.now() + 30000);
    for (const [key, expiry] of pumpTickets) if (expiry < Date.now()) pumpTickets.delete(key);
    return res.json({ ticket, expiresIn: 30 });
  } catch (error) {
    console.error("PumpPortal ticket issue failed:", error.message);
    return res.status(401).json({ error: "Could not verify admin session." });
  }
});

// Resolve token metadata (including its logo) from the mint/contract address.
const tokenMetaCache = new Map();
const tokenMetaLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 40,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Token metadata request limit reached. Please wait a moment." }
});
app.get("/api/token-meta", tokenMetaLimiter, async (req, res) => {
  const mint = String(req.query.mint || "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: "Invalid Solana token address." });
  }
  const cached = tokenMetaCache.get(mint);
  if (cached && Date.now() - cached.time < 30000) return res.json(cached.data);
  try {
    const upstream = await fetch("https://api.dexscreener.com/token-pairs/v1/solana/" + encodeURIComponent(mint), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "Token metadata provider returned " + upstream.status + "." });
    const body = await upstream.json();
    const pairs = (Array.isArray(body) ? body : body.pairs || [])
      .filter(p => p.chainId === "solana" && String(p.baseToken?.address || "").toLowerCase() === mint.toLowerCase())
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const p = pairs[0];
    let embeddedMeta = {};
    // For fresh launches that have not been indexed by DexScreener yet,
    // use the metadata URI included in PumpPortal's create event.
    if (!p || !p.info?.imageUrl) {
      const launch = recentPumpLaunches.find(x => String(x.mint || "").toLowerCase() === mint.toLowerCase());
      let uri = String(launch?.uri || "");
      if (uri.startsWith("ipfs://")) uri = "https://ipfs.io/ipfs/" + uri.slice(7).replace(/^ipfs\//, "");
      if (uri.startsWith("ar://")) uri = "https://arweave.net/" + uri.slice(5);
      if (uri.startsWith("https://")) {
        try {
          const target = new URL(uri);
          const allowed = ["ipfs.io", "arweave.net", "gateway.pinata.cloud", "cf-ipfs.com", "dweb.link"];
          if (allowed.includes(target.hostname)) {
            const mr = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6500) });
            const length = Number(mr.headers.get("content-length") || 0);
            if (mr.ok && (!length || length <= 262144)) embeddedMeta = await mr.json();
          }
        } catch (metaError) {
          console.warn("token URI metadata lookup failed:", metaError.message);
        }
      }
    }
    const image = p?.info?.imageUrl || p?.info?.header || embeddedMeta.image || embeddedMeta.image_url || null;
    let imageUrl = typeof image === "string" ? image : null;
    if (imageUrl?.startsWith("ipfs://")) imageUrl = "https://ipfs.io/ipfs/" + imageUrl.slice(7).replace(/^ipfs\//, "");
    if (imageUrl?.startsWith("ar://")) imageUrl = "https://arweave.net/" + imageUrl.slice(5);
    const data = {
      mint,
      name: p?.baseToken?.name || embeddedMeta.name || "",
      symbol: p?.baseToken?.symbol || embeddedMeta.symbol || "",
      imageUrl: imageUrl?.startsWith("https://") ? imageUrl : null,
      priceUsd: Number(p?.priceUsd) || 0,
      liquidityUsd: Number(p?.liquidity?.usd) || 0,
      fdv: Number(p?.fdv) || 0,
      marketCap: Number(p?.marketCap || p?.fdv) || 0,
      volume24h: Number(p?.volume?.h24) || 0,
      pairAddress: p?.pairAddress || "",
      dexId: p?.dexId || "",
      pairCreatedAt: Number(p?.pairCreatedAt) || null,
      url: p?.url || "",
      websites: p?.info?.websites || (embeddedMeta.website ? [{ url: embeddedMeta.website }] : []),
      socials: p?.info?.socials || []
    };
    if (!p && !data.name && !data.symbol && !data.imageUrl) {
      return res.status(404).json({ error: "No token metadata is indexed for this address yet." });
    }
    tokenMetaCache.set(mint, { time: Date.now(), data });
    if (tokenMetaCache.size > 500) tokenMetaCache.delete(tokenMetaCache.keys().next().value);
    return res.json(data);
  } catch (error) {
    console.error("token metadata lookup failed:", error.message);
    return res.status(502).json({ error: "Token metadata is temporarily unavailable." });
  }
});

// Verify Supabase sessions server-side and allow only the configured administrator.
app.post("/api/admin/check", async (req, res) => {
  if (!ADMIN_EMAIL || !supabaseAdmin) {
    return res.status(503).json({ error: "Administrator access is not configured. Set ADMIN_EMAIL in the Render environment." });
  }
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Please sign in again." });

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(match[1]);
    if (error || !data?.user) return res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
    if ((data.user.email || "").trim().toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: "This account is not authorized for administrator access." });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error("admin access check failed:", error.message);
    return res.status(401).json({ error: "Could not verify your administrator session." });
  }
});

app.post("/api/waitlist", waitlistLimiter, async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: "Waitlist storage is not configured yet." });
  const { handle, referralCode, consent, website } = req.body || {};
  if (website) return res.status(400).json({ error: "Invalid submission." });
  const clean = String(handle || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(clean)) {
    return res.status(400).json({ error: "Enter a valid X handle (up to 15 letters, numbers or underscores)." });
  }

  try {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("waitlist").select("handle, referral_code").eq("handle", clean).maybeSingle();
    if (existingError) throw existingError;

    let user = existing;
    if (!user) {
      let referredBy = null;
      const requestedRef = typeof referralCode === "string" ? referralCode.trim().toLowerCase() : "";
      if (/^[a-f0-9]{10}$/.test(requestedRef)) {
        const { data: referrer, error: refError } = await supabaseAdmin
          .from("waitlist").select("referral_code").eq("referral_code", requestedRef).maybeSingle();
        if (refError) throw refError;
        if (referrer) referredBy = referrer.referral_code;
      }
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("waitlist")
        .insert({
          handle: clean,
          referral_code: randomBytes(5).toString("hex"),
          referred_by: referredBy,
          consent: consent === true
        })
        .select("handle, referral_code").single();

      if (insertError && insertError.code === "23505") {
        const { data: racedUser, error: racedError } = await supabaseAdmin
          .from("waitlist").select("handle, referral_code").eq("handle", clean).maybeSingle();
        if (racedError || !racedUser) throw racedError || insertError;
        user = racedUser;
      } else if (insertError) throw insertError;
      else user = inserted;
    }

    const { count, error: countError } = await supabaseAdmin
      .from("waitlist").select("id", { count: "exact", head: true }).eq("referred_by", user.referral_code);
    if (countError) throw countError;

    res.status(existing ? 200 : 201).json({
      user: { handle: user.handle, code: user.referral_code, referrals: count || 0, status: "On the waitlist" }
    });
  } catch (error) {
    console.error("waitlist error:", error.message);
    res.status(500).json({ error: "Could not save your signup. Please try again." });
  }
});

const geckoCache = new Map();
const geckoInflight = new Map();
let geckoQueue = Promise.resolve();
let geckoNextRequestAt = 0;
const GECKO_FRESH_MS = 60 * 1000;
const GECKO_STALE_MS = 15 * 60 * 1000;
const GECKO_MIN_GAP_MS = 7000;
const waitMs = ms => new Promise(resolve => setTimeout(resolve, ms));

app.get("/api/gecko", geckoLimiter, async (req, res) => {
  const apiPath = String(req.query.path || "");
  if (!apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.includes("..") || apiPath.length > 500) {
    return res.status(400).json({ error: "Invalid market-data path." });
  }

  // The scanner resolves tickers through GeckoTerminal's pool search.
  // Permit only Solana search results; all other network searches stay blocked.
  let parsedPath;
  try {
    parsedPath = new URL(apiPath, "https://api.geckoterminal.com");
  } catch {
    return res.status(400).json({ error: "Invalid market-data path." });
  }
  const isSolanaSearch = parsedPath.pathname === "/search/pools" &&
    parsedPath.searchParams.get("network") === "solana";
  const isSolanaNetworkPath = parsedPath.pathname.startsWith("/networks/solana/");
  const isTokenInfoPath = parsedPath.pathname.startsWith("/tokens/");
  if (!isSolanaSearch && !isSolanaNetworkPath && !isTokenInfoPath) {
    return res.status(400).json({ error: "Unsupported market-data path." });
  }

  const cached = geckoCache.get(apiPath);
  const age = cached ? Date.now() - cached.time : Infinity;
  if (cached && age < GECKO_FRESH_MS) {
    res.set("X-Data-Cache", "HIT");
    return res.json(cached.data);
  }

  // Coalesce the same URL across browser tabs/users. Never fan out duplicate
  // requests to GeckoTerminal for a pool/candle range that is already loading.
  let pending = geckoInflight.get(apiPath);
  if (!pending) {
    pending = (async () => {
      const performRequest = async () => {
        const wait = Math.max(0, geckoNextRequestAt - Date.now());
        if (wait) await waitMs(wait);
        geckoNextRequestAt = Date.now() + GECKO_MIN_GAP_MS;

        const upstream = await fetch("https://api.geckoterminal.com/api/v2" + apiPath, {
          headers: { Accept: "application/json;version=20230302" },
          signal: AbortSignal.timeout(12000)
        });
        const body = await upstream.json().catch(() => ({}));

        if (upstream.status === 429) {
          const retryHeader = Number(upstream.headers.get("retry-after") || 0);
          const cooldown = retryHeader > 0
            ? Math.min(120000, Math.max(15000, retryHeader * 1000))
            : 30000;
          geckoNextRequestAt = Math.max(geckoNextRequestAt, Date.now() + cooldown);
          const error = new Error("GeckoTerminal rate limited the free public API.");
          error.status = 429;
          error.retryAfter = Math.ceil(cooldown / 1000);
          throw error;
        }
        if (!upstream.ok) {
          const error = new Error("GeckoTerminal returned HTTP " + upstream.status + ".");
          error.status = upstream.status;
          throw error;
        }

        geckoCache.set(apiPath, { time: Date.now(), data: body });
        if (geckoCache.size > 400) {
          const oldestKey = geckoCache.keys().next().value;
          geckoCache.delete(oldestKey);
        }
        return body;
      };

      const queued = geckoQueue.then(performRequest, performRequest);
      geckoQueue = queued.then(() => undefined, () => undefined);
      return queued;
    })();
    geckoInflight.set(apiPath, pending);
    pending.finally(() => {
      if (geckoInflight.get(apiPath) === pending) geckoInflight.delete(apiPath);
    }).catch(() => {});
  }

  try {
    const data = await pending;
    res.set("X-Data-Cache", "MISS");
    return res.set("Cache-Control", "public, max-age=30").json(data);
  } catch (error) {
    // Stale data is much better than an empty chart during a temporary 429.
    const latest = geckoCache.get(apiPath);
    const staleAge = latest ? Date.now() - latest.time : Infinity;
    if (latest && staleAge < GECKO_STALE_MS) {
      res.set("X-Data-Cache", "STALE");
      res.set("X-Data-Stale-Age", String(Math.round(staleAge / 1000)));
      return res.set("Cache-Control", "public, max-age=15").json(latest.data);
    }
    if (error.status === 429) {
      res.set("Retry-After", String(error.retryAfter || 30));
      return res.status(503).json({
        error: "GeckoTerminal's free API is temporarily rate-limited. Cached data is not available yet; retry shortly."
      });
    }
    console.error("GeckoTerminal proxy error:", error.message);
    return res.status(502).json({ error: "Market data is temporarily unavailable." });
  }
});


// Jupiter Tokens V2 is the primary trending-token provider.
// Keyless access is supported; a free API key can be added later via JUPITER_API_KEY.
const jupiterLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Jupiter market-data request limit reached. Please wait a moment." }
});
const jupiterCache = new Map();
const jupiterInflight = new Map();
const jupiterPriceHistory = new Map();
let jupiterQueue = Promise.resolve();
let jupiterNextRequestAt = 0;
const JUPITER_FRESH_MS = 55 * 1000;
const JUPITER_STALE_MS = 10 * 60 * 1000;
const JUPITER_HISTORY_SAMPLE_MS = 55 * 1000;
const jupiterWait = ms => new Promise(resolve => setTimeout(resolve, ms));

const recordJupiterPriceSnapshot = (tokens, sampledAt) => {
  if (!Array.isArray(tokens) || !Number.isFinite(sampledAt)) return;
  for (const token of tokens) {
    const mint = String(token?.id || "");
    const price = Number(token?.usdPrice);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !(price > 0)) continue;
    let history = jupiterPriceHistory.get(mint);
    if (!history) {
      history = [];
      jupiterPriceHistory.set(mint, history);
    }
    const last = history[history.length - 1];
    if (last && sampledAt - last.at < JUPITER_HISTORY_SAMPLE_MS) continue;
    history.push({ at: sampledAt, price });
    while (history.length > 40 || history.length && sampledAt - history[0].at > 45 * 60 * 1000) history.shift();
  }
  if (jupiterPriceHistory.size > 1200) {
    const oldest = jupiterPriceHistory.keys().next().value;
    jupiterPriceHistory.delete(oldest);
  }
};

const jupiterRollingChange = (mint, currentPrice, minutes, at = Date.now()) => {
  const history = jupiterPriceHistory.get(mint) || [];
  const targetAt = at - minutes * 60 * 1000;
  const baseline = [...history].reverse().find(sample => sample.at <= targetAt);
  if (!baseline || at - baseline.at > (minutes * 60 * 1000) + 150 * 1000 || !(baseline.price > 0)) return null;
  return ((currentPrice / baseline.price) - 1) * 100;
};

const getJupiterTrending = async (providerInterval) => {
  const apiPath = "/toptrending/" + providerInterval + "?limit=100";
  const cached = jupiterCache.get(apiPath);
  const cacheAge = cached ? Date.now() - cached.time : Infinity;
  if (cached && cacheAge < JUPITER_FRESH_MS) return cached;

  let pending = jupiterInflight.get(apiPath);
  if (!pending) {
    pending = (async () => {
      const performRequest = async () => {
        const minGap = JUPITER_API_KEY ? 1100 : 2100;
        const wait = Math.max(0, jupiterNextRequestAt - Date.now());
        if (wait) await jupiterWait(wait);
        jupiterNextRequestAt = Date.now() + minGap;

        const headers = { Accept: "application/json" };
        if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;
        const upstream = await fetch("https://api.jup.ag/tokens/v2" + apiPath, {
          headers,
          signal: AbortSignal.timeout(12000)
        });
        const body = await upstream.json().catch(() => ({}));

        if (upstream.status === 429) {
          const retryHeader = Number(upstream.headers.get("retry-after") || 0);
          const cooldown = retryHeader > 0
            ? Math.min(120000, Math.max(10000, retryHeader * 1000))
            : 30000;
          jupiterNextRequestAt = Math.max(jupiterNextRequestAt, Date.now() + cooldown);
          const error = new Error("Jupiter's free Tokens API is temporarily rate-limited.");
          error.status = 429;
          error.retryAfter = Math.ceil(cooldown / 1000);
          throw error;
        }
        if (!upstream.ok) {
          const error = new Error("Jupiter Tokens API returned HTTP " + upstream.status + ".");
          error.status = upstream.status;
          throw error;
        }
        const tokens = Array.isArray(body) ? body : Array.isArray(body.tokens) ? body.tokens : Array.isArray(body.data) ? body.data : null;
        if (!tokens) {
          const error = new Error("Jupiter Tokens API returned an unexpected response.");
          error.status = 502;
          throw error;
        }
        const entry = { time: Date.now(), data: tokens };
        jupiterCache.set(apiPath, entry);
        if (jupiterCache.size > 32) jupiterCache.delete(jupiterCache.keys().next().value);
        return entry;
      };

      const queued = jupiterQueue.then(performRequest, performRequest);
      jupiterQueue = queued.then(() => undefined, () => undefined);
      return queued;
    })();
    jupiterInflight.set(apiPath, pending);
    pending.finally(() => {
      if (jupiterInflight.get(apiPath) === pending) jupiterInflight.delete(apiPath);
    }).catch(() => {});
  }

  try {
    return await pending;
  } catch (error) {
    if (cached && Date.now() - cached.time < JUPITER_STALE_MS) {
      return { ...cached, stale: true, error: error.message };
    }
    throw error;
  }
};

app.get("/api/jupiter/trending", jupiterLimiter, async (req, res) => {
  const interval = String(req.query.interval || "5m");
  if (!["5m", "15m", "30m", "1h", "24h"].includes(interval)) {
    return res.status(400).json({ error: "Unsupported interval. Use 5m, 15m, 30m, 1h or 24h." });
  }
  // Jupiter provides native rankings for 5m, 1h and 24h. 15m/30m
  // use genuine rolling prices collected from the 5m trending feed.
  const providerInterval = interval === "15m" || interval === "30m" ? "5m" : interval;
  try {
    const entry = await getJupiterTrending(providerInterval);
    const data = entry.data.map(token => {
      const mint = String(token?.id || "");
      const price = Number(token?.usdPrice) || 0;
      return {
        ...token,
        priceChange15m: price ? jupiterRollingChange(mint, price, 15, entry.time) : null,
        priceChange30m: price ? jupiterRollingChange(mint, price, 30, entry.time) : null
      };
    });
    recordJupiterPriceSnapshot(entry.data, entry.time);
    res.set("X-Data-Cache", entry.stale ? "STALE" : (Date.now() - entry.time < 1500 ? "MISS" : "HIT"));
    if (entry.stale) res.set("X-Data-Stale-Age", String(Math.round((Date.now() - entry.time) / 1000)));
    return res.set("Cache-Control", "public, max-age=20").json({
      provider: "jupiter-tokens-v2",
      interval,
      providerInterval,
      fetchedAt: new Date(entry.time).toISOString(),
      stale: Boolean(entry.stale),
      tokens: data
    });
  } catch (error) {
    console.error("Jupiter trending proxy error:", error.message);
    if (error.status === 429) {
      res.set("Retry-After", String(error.retryAfter || 30));
      return res.status(503).json({ error: "Jupiter's free API is temporarily rate-limited. Please retry shortly." });
    }
    return res.status(502).json({ error: "Jupiter market data is temporarily unavailable." });
  }
});

// Warm one 5m price-history stream every minute. This powers genuine 15m/30m
// changes without asking the browser to fan out extra API calls.
let jupiterWarmupLogged = false;
const warmJupiterHistory = async () => {
  try {
    const entry = await getJupiterTrending("5m");
    recordJupiterPriceSnapshot(entry.data, entry.time);
    if (!jupiterWarmupLogged) {
      console.log("Jupiter Tokens V2 connected · " + entry.data.length + " trending tokens available");
      jupiterWarmupLogged = true;
    }
  } catch (error) {
    console.warn("Jupiter price-history warmup skipped:", error.message);
  }
};
const jupiterWarmTimer = setTimeout(() => {
  warmJupiterHistory();
  const timer = setInterval(warmJupiterHistory, 60 * 1000);
  timer.unref?.();
}, 5000);
jupiterWarmTimer.unref?.();

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  setHeaders(res, filePath) {
    // Never cache HTML: it contains the public waitlist and admin-only login UI.
    // This prevents browsers or intermediary caches from reviving an old signup screen after a deploy.
    if (path.extname(filePath).toLowerCase() === ".html") {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("CDN-Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
// One upstream PumpPortal connection serves every terminal session.
const httpServer = app.listen(PORT, "0.0.0.0", () => console.log("alpha running on port " + PORT));
const pumpClients = new Set();
const recentPumpLaunches = [];
const recentPumpMigrations = [];
const pumpWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
let pumpSocket = null;
let pumpReconnectDelay = 1000;
let pumpReconnectTimer = null;

const sendPumpClient = (client, payload) => {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
};
const broadcastPump = payload => {
  for (const client of pumpClients) sendPumpClient(client, payload);
};

pumpWss.on("connection", client => {
  pumpClients.add(client);
  sendPumpClient(client, {
    type: "snapshot",
    newTokens: recentPumpLaunches,
    migrations: recentPumpMigrations
  });
  sendPumpClient(client, {
    type: "status",
    connected: pumpSocket?.readyState === WebSocket.OPEN,
    freeStreams: ["newToken", "migration"]
  });
  client.on("close", () => pumpClients.delete(client));
  client.on("error", () => pumpClients.delete(client));
});

httpServer.on("upgrade", (request, socket, head) => {
  let pathname = "";
  try { pathname = new URL(request.url, "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== "/ws/pumpportal") {
    socket.destroy();
    return;
  }
  let ticket = "";
  try { ticket = new URL(request.url, "http://localhost").searchParams.get("ticket") || ""; }
  catch { socket.destroy(); return; }
  const expiresAt = pumpTickets.get(ticket);
  pumpTickets.delete(ticket);
  if (!expiresAt || expiresAt < Date.now()) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  pumpWss.handleUpgrade(request, socket, head, client => {
    pumpWss.emit("connection", client, request);
  });
});

function connectPumpPortal() {
  if (pumpReconnectTimer) clearTimeout(pumpReconnectTimer);
  // Only the free launch and migration feeds are subscribed to here.
  const upstream = new WebSocket("wss://pumpportal.fun/api/data");
  pumpSocket = upstream;
  upstream.on("open", () => {
    pumpReconnectDelay = 1000;
    upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    upstream.send(JSON.stringify({ method: "subscribeMigration" }));
    broadcastPump({ type: "status", connected: true, freeStreams: ["newToken", "migration"] });
    console.log("PumpPortal free launch + migration websocket connected");
  });
  upstream.on("message", raw => {
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch { return; }
    if (!event || typeof event !== "object") return;
    const receivedAt = Date.now();

    if (event.txType === "create" && event.mint) {
      const item = { ...event, receivedAt };
      const old = recentPumpLaunches.findIndex(x => x.mint === item.mint);
      if (old >= 0) recentPumpLaunches.splice(old, 1);
      recentPumpLaunches.unshift(item);
      if (recentPumpLaunches.length > 120) recentPumpLaunches.length = 120;
      broadcastPump({ type: "newToken", data: item });
      return;
    }
    if (["migrate", "complete", "create_pool", "migration"].includes(event.txType) ||
        (event.source === "pumpswap" && event.isCanonicalPool === true)) {
      const item = { ...event, receivedAt };
      recentPumpMigrations.unshift(item);
      if (recentPumpMigrations.length > 80) recentPumpMigrations.length = 80;
      broadcastPump({ type: "migration", data: item });
    }
  });
  upstream.on("error", error => {
    console.error("PumpPortal free websocket error:", error.message);
    try { upstream.terminate(); } catch {}
  });
  upstream.on("close", () => {
    if (pumpSocket === upstream) pumpSocket = null;
    broadcastPump({ type: "status", connected: false, freeStreams: ["newToken", "migration"] });
    const delay = pumpReconnectDelay;
    pumpReconnectDelay = Math.min(pumpReconnectDelay * 2, 30000);
    pumpReconnectTimer = setTimeout(connectPumpPortal, delay);
    pumpReconnectTimer.unref?.();
  });
}
connectPumpPortal();
