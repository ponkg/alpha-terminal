# alpha — Solana narrative intelligence

A deployable full-stack MVP based on the supplied alpha terminal prototype.

## Stack
- Node.js + Express on Render Free
- Supabase Auth for administrator-only email/password login (public signup is disabled during closed beta)
- Supabase Postgres for the waitlist and referral records
- GeckoTerminal proxy served by Express

## Supabase project
The existing Supabase project is named **alpha** and is in the Tokyo region (`ap-northeast-1`). Its `public.waitlist` table is already provisioned with Row Level Security enabled. Do not create a second project or re-run the schema unless setting up a separate environment.

The schema definition is kept in [supabase/schema.sql](supabase/schema.sql).

Waitlist submissions are stored in **Supabase → Database → Table Editor → `public.waitlist`**. They are not stored on Render. The service uses the backend-only `SUPABASE_SECRET_KEY` to write to this table while public browser access is blocked by RLS.

The app needs:
- Project URL: `SUPABASE_URL`
- Publishable key: `SUPABASE_PUBLISHABLE_KEY` (safe to expose in the browser)
- Secret key: `SUPABASE_SECRET_KEY` (backend only; never put it in browser code or Git)

The Render Blueprint pre-fills the project URL and publishable key. Add the secret key manually in the Render service Environment page.

Supabase Free currently includes 500 MB database storage and 50,000 monthly active users. Free projects may pause after one week of inactivity and do not include automatic backups. See https://supabase.com/pricing.

## Supabase Auth — closed beta
The public site has no registration form. Visitors can only request early access through the original X-handle waitlist. The terminal login is reserved for one administrator email.

1. In Supabase, open **Authentication → Sign In / Providers → Email** and turn off **Allow new users to sign up**. Existing accounts can still sign in. Create the administrator account manually from **Authentication → Users** if it does not already exist. See https://supabase.com/docs/guides/auth/general-configuration.
2. In Render, set `ADMIN_EMAIL` to the exact email address of that existing Supabase Auth administrator account. The server validates the Supabase access token and rejects any other email. Until `ADMIN_EMAIL` and `SUPABASE_SECRET_KEY` are configured, admin login fails closed.
3. After Render creates the site URL, open **Authentication → URL Configuration**:
   - Set Site URL to `https://YOUR-SERVICE.onrender.com`
   - Add that same origin to the Redirect URLs allow list

The public waitlist is separate from Supabase Auth accounts. Waitlist submissions are saved in `public.waitlist` and do not create a login. Supabase's default email sender is best-effort and limited to 2 emails per hour; configure custom SMTP before sending more auth emails. See https://supabase.com/docs/guides/auth/passwords.

## PumpPortal coin tracker

The coin tracker uses the PumpPortal Data API for live token launches, migrations, and per-token trade events. The server keeps one upstream WebSocket connection and exposes an admin-ticket-protected WebSocket to the frontend. Token logos and market metadata are resolved by mint address through DexScreener, with a PumpPortal metadata-URI fallback for fresh launches.

- New-token and migration subscriptions are free.
- Per-token trade subscriptions require a PumpPortal API key and linked wallet funded with at least 0.02 SOL.
- PumpPortal meters trade messages at 0.01 SOL per 10,000 events. Add `PUMPPORTAL_API_KEY` to Render Environment only when you want live per-token trades; keep it server-side.
- PumpPortal does not provide historical candles. GeckoTerminal is retained only for historical OHLCV backfill and holder data.
- Without `PUMPPORTAL_API_KEY`, the launches and migrations tabs still work, but selected-token live trade candles/trade tape remain unavailable.

Get the key from the PumpPortal Data API setup page and add it as `PUMPPORTAL_API_KEY` in the Render service Environment. Do not commit it to GitHub or expose it in browser configuration.

## Run locally
Requires Node.js 20+.

    npm install
    cp .env.example .env
    # Fill in the three Supabase settings in .env
    npm run dev

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

## Deploy on Render Free
Connect this GitHub repository to Render and create the web service from `render.yaml`. It uses the Free plan and no persistent disk; waitlist data is stored in Supabase.

Set `SUPABASE_SECRET_KEY` in the Render Environment page. The project URL and publishable key are already set by the Blueprint.

Render Free web services spin down after 15 minutes without inbound traffic. The first request after sleep takes about a minute. The filesystem is ephemeral, so SQLite is intentionally not used. Render documents the free-plan limitations at https://render.com/docs/free.

## Security notes
- Supabase Auth handles password hashing, email confirmation and browser sessions.
- The browser receives only the publishable key.
- The waitlist table has Row Level Security enabled and no client read/write policies; the backend uses the secret key for waitlist operations.
- The waitlist endpoint has request-rate limiting and a honeypot field.
- Admin terminal access is checked server-side against `ADMIN_EMAIL`; the browser never receives the Supabase secret key.
- Phantom is a wallet connection within an authenticated session, not a substitute for account authentication.
- Google/X OAuth are not enabled in this version.
- Some scanner/holder views may use illustrative or provider-dependent data. Narrative classification remains heuristic, not a validated trading signal.
- Add a privacy policy, terms, monitoring, error reporting and backups before treating this as a production financial product.

Never ask users for seed phrases or private keys.