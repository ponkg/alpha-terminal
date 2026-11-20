# alpha — Solana narrative intelligence

A deployable full-stack MVP based on the supplied alpha terminal prototype.

## Stack
- Node.js + Express on Render Free
- Supabase Auth for email/password registration and login
- Supabase Postgres for the waitlist and referral records
- GeckoTerminal proxy served by Express

## Supabase project
The existing Supabase project is named **alpha** and is in the Tokyo region (`ap-northeast-1`). Its `public.waitlist` table is already provisioned with Row Level Security enabled. Do not create a second project or re-run the schema unless setting up a separate environment.

The schema definition is kept in [supabase/schema.sql](supabase/schema.sql).

The app needs:
- Project URL: `SUPABASE_URL`
- Publishable key: `SUPABASE_PUBLISHABLE_KEY` (safe to expose in the browser)
- Secret key: `SUPABASE_SECRET_KEY` (backend only; never put it in browser code or Git)

The Render Blueprint pre-fills the project URL and publishable key. Add the secret key manually in the Render service Environment page.

Supabase Free currently includes 500 MB database storage and 50,000 monthly active users. Free projects may pause after one week of inactivity and do not include automatic backups. See https://supabase.com/pricing.

## Supabase Auth
Email/password authentication is enabled by default on hosted Supabase projects. Email confirmation is enabled by default too. Keep confirmation enabled for the beta unless you have a reason to disable it.

After Render creates the site URL, open **Authentication → URL Configuration**:
- Set Site URL to `https://YOUR-SERVICE.onrender.com`
- Add that same origin to the Redirect URLs allow list
- For local development, also allow `http://localhost:3000/**`

The registration form sends users back to the current site after email confirmation, and the browser restores the Supabase session. Supabase default email sending is limited to 2 messages per hour and is best-effort; configure custom SMTP before inviting more than a small test group. See https://supabase.com/docs/guides/auth/passwords.

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
- The browser account gate is for the current MVP experience. Any future user-specific API or private account data must validate the user Supabase access token server-side and enforce RLS.
- Phantom is a wallet connection within an authenticated session, not a substitute for account authentication.
- Google/X OAuth are not enabled in this version.
- Some scanner/holder views may use illustrative or provider-dependent data. Narrative classification remains heuristic, not a validated trading signal.
- Add a privacy policy, terms, monitoring, error reporting and backups before treating this as a production financial product.

Never ask users for seed phrases or private keys.