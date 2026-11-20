import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
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
  windowMs: 60 * 1000, limit: 45,
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

app.get("/api/health", (_req, res) => res.json({
  ok: true, service: "alpha-api", authConfigured, databaseConfigured
}));

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
app.get("/api/gecko", geckoLimiter, async (req, res) => {
  const apiPath = String(req.query.path || "");
  if (!apiPath.startsWith("/networks/solana/") && !apiPath.startsWith("/tokens/")) {
    return res.status(400).json({ error: "Unsupported market-data path." });
  }
  if (apiPath.includes("..") || apiPath.length > 500) {
    return res.status(400).json({ error: "Invalid market-data path." });
  }
  const cached = geckoCache.get(apiPath);
  if (cached && Date.now() - cached.time < 8000) return res.json(cached.data);
  try {
    const upstream = await fetch("https://api.geckoterminal.com/api/v2" + apiPath, {
      headers: { Accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(12000)
    });
    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({
      error: upstream.status === 429
        ? "Market-data provider is rate limiting. Retry shortly."
        : "Market-data provider returned " + upstream.status + "."
    });
    geckoCache.set(apiPath, { time: Date.now(), data: body });
    if (geckoCache.size > 250) geckoCache.delete(geckoCache.keys().next().value);
    res.set("Cache-Control", "public, max-age=5").json(body);
  } catch {
    res.status(502).json({ error: "Market-data provider is temporarily unavailable." });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("alpha running on port " + PORT));
