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
  windowMs: 60 * 1000, limit: 12,
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
    const upstream = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "Token metadata provider returned " + upstream.status + "." });
    const body = await upstream.json();
    const pairs = (body.pairs || [])
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
let geckoQueue = Promise.resolve();
let geckoNextRequestAt = 0;
app.get("/api/gecko", geckoLimiter, async (req, res) => {
  const apiPath = String(req.query.path || "");
  if (!apiPath.startsWith("/networks/solana/") && !apiPath.startsWith("/tokens/")) {
    return res.status(400).json({ error: "Unsupported market-data path." });
  }
  if (apiPath.includes("..") || apiPath.length > 500) {
    return res.status(400).json({ error: "Invalid market-data path." });
  }
  const cached = geckoCache.get(apiPath);
  if (cached && Date.now() - cached.time < 60000) return res.json(cached.data);
  try {
    // GeckoTerminal public API is limited to about 10 calls/min. Serialize upstream
    // requests and leave a 7-second gap globally across all app users.
    const performRequest = async () => {
      const wait = Math.max(0, geckoNextRequestAt - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      geckoNextRequestAt = Date.now() + 7000;
      const upstream = await fetch("https://api.geckoterminal.com/api/v2" + apiPath, {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(12000)
      });
      const body = await upstream.json();
      return { upstream, body };
    };
    const request = geckoQueue.then(performRequest, performRequest);
    geckoQueue = request.then(() => undefined, () => undefined);
    const { upstream, body } = await request;
    if (!upstream.ok) return res.status(upstream.status).json({
      error: upstream.status === 429
        ? "Market-data provider is rate limiting. Retry shortly."
        : "Market-data provider returned " + upstream.status + "."
    });
    geckoCache.set(apiPath, { time: Date.now(), data: body });
    if (geckoCache.size > 250) geckoCache.delete(geckoCache.keys().next().value);
    res.set("Cache-Control", "public, max-age=30").json(body);
  } catch {
    res.status(502).json({ error: "Market-data provider is temporarily unavailable." });
  }
});

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
