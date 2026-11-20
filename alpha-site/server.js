import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "alpha.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL UNIQUE,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by TEXT,
    consent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(referred_by) REFERENCES waitlist(referral_code)
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_code TEXT NOT NULL,
    referred_handle TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(referrer_code) REFERENCES waitlist(referral_code)
  );
`);
app.disable("x-powered-by");
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

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO waitlist (handle, referral_code, referred_by, consent)
  VALUES (@handle, @code, @ref, @consent)
`);
const getUser = db.prepare(`
  SELECT handle, referral_code AS code, consent, created_at AS createdAt
  FROM waitlist WHERE handle = ?
`);
const countReferrals = db.prepare(`
  SELECT COUNT(*) AS count FROM referrals WHERE referrer_code = ?
`);
const addReferral = db.prepare(`
  INSERT OR IGNORE INTO referrals (referrer_code, referred_handle) VALUES (?, ?)
`);
const createSignup = db.transaction(({ handle, ref, consent }) => {
  const existing = getUser.get(handle);
  if (existing) return existing;
  const code = randomBytes(6).toString("hex").slice(0, 10);
  const validRef = ref && db.prepare("SELECT 1 FROM waitlist WHERE referral_code = ?").get(ref)
    ? ref : null;
  insertUser.run({ handle, code, ref: validRef, consent: consent ? 1 : 0 });
  if (validRef) addReferral.run(validRef, handle);
  return getUser.get(handle);
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "alpha-api" }));

app.post("/api/waitlist", waitlistLimiter, (req, res) => {
  const { handle, referralCode, consent, website } = req.body || {};
  if (website) return res.status(400).json({ error: "Invalid submission." });
  const clean = String(handle || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) {
    return res.status(400).json({ error: "Enter a valid X handle (up to 15 letters, numbers or underscores)." });
  }
  try {
    const user = createSignup({
      handle: clean.toLowerCase(),
      ref: typeof referralCode === "string" ? referralCode.toLowerCase() : null,
      consent: consent === true
    });
    const referrals = countReferrals.get(user.code).count;
    return res.status(201).json({
      user: { handle: user.handle, code: user.code, referrals, status: "On the waitlist" }
    });
  } catch (error) {
    console.error("waitlist error:", error);
    return res.status(500).json({ error: "Could not save your signup. Please try again." });
  }
});

// Keep GeckoTerminal access same-origin and restrict the proxy to its public Solana API.
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
    const upstream = await fetch(`https://api.geckoterminal.com/api/v2${apiPath}`, {
      headers: { Accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(12000)
    });
    const body = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: upstream.status === 429 ? "Market-data provider is rate limiting. Retry shortly." : `Market-data provider returned ${upstream.status}.`
      });
    }
    geckoCache.set(apiPath, { time: Date.now(), data: body });
    if (geckoCache.size > 250) geckoCache.delete(geckoCache.keys().next().value);
    res.set("Cache-Control", "public, max-age=5").json(body);
  } catch (error) {
    res.status(502).json({ error: "Market-data provider is temporarily unavailable." });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`alpha running on http://localhost:${PORT}`));
