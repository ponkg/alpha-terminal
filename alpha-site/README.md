# alpha — Solana narrative intelligence

A deployable first full-stack version of the supplied alpha HTML prototype. The original terminal UI is preserved.

## What is connected

- GeckoTerminal requests now go through a same-origin server endpoint, with basic caching, input restrictions and rate limiting.
- Waitlist signups are saved in SQLite instead of browser localStorage.
- Referral codes are generated server-side and referral attribution/counts are persisted.
- Basic security headers, request-size limits and endpoint rate limits are enabled.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

The SQLite database is created at `data/alpha.sqlite` by default. Set `DB_PATH` to a persistent disk path in production.

## Deploy

Deploy as a Node web service (Render, Railway, Fly.io, or a VPS):

- Build command: `npm install`
- Start command: `npm start`
- Node version: 20 or newer
- Attach a persistent disk and set `DB_PATH` to a path on that disk. Without persistent storage, SQLite data can be lost when the host replaces the instance.
- Set `NODE_ENV=production`.

Use HTTPS and configure backups for the SQLite database.

## Important limitations before public launch

This is a functional MVP foundation, not a fully audited production trading platform.

- The existing terminal's login form still contains a local demo credential (`admin` / `1234`) and is **not secure authentication**. Do not expose it as real account security. Replace it with a provider such as Privy or Supabase Auth before allowing private user accounts.
- Phantom connection is a browser wallet connection only; it does not authenticate a user with a signed message.
- X and Google buttons are placeholders; OAuth credentials and callback routes are not configured.
- The X feed and parts of the scanner / holder views may still show illustrative or provider-dependent data. Review each view before representing it as live.
- Narrative classification is keyword-based heuristic grouping, not an AI model or validated signal.
- GeckoTerminal public API availability and rate limits are controlled by the provider.
- Add privacy policy, terms, monitoring, error reporting, database backups and abuse controls before a broad public launch.

Never ask users for seed phrases or private keys.
