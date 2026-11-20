# alpha — Solana narrative intelligence

A deployable full-stack MVP based on the supplied alpha terminal prototype.

## Stack
- Node.js + Express on Render Free
- Supabase Auth for email/password registration and login
- Supabase Postgres for the waitlist and referral records
- GeckoTerminal proxy served by Express

## 1. Create a Supabase project
Create a Free project in Supabase, then open the SQL Editor and run supabase/schema.sql.

In Project Settings → API Keys, copy the Project URL, Publishable key (sb_publishable_...) and Secret key (sb_secret_...). Keep the secret key private: it belongs only in Render's backend environment, never in browser code or Git.

Supabase Free currently includes 500 MB database storage and 50,000 monthly active users. Free projects may pause after one week of inactivity and do not include automatic backups. See https://supabase.com/pricing.

## 2. Configure Supabase Auth
In Authentication → Providers, enable Email and allow new user signups. Decide whether email confirmation is required.

After Render creates the site's URL, open Authentication → URL Configuration:
- Set Site URL to https://YOUR-SERVICE.onrender.com
- Add that same origin to the Redirect URLs allow list
- For local development, also allow http://localhost:3000/**

Email confirmation redirects back to the site; the app restores the Supabase session automatically. For a larger beta, configure custom SMTP rather than relying on Supabase's low-volume default email sender.

## 3. Run locally
Requires Node.js 20+.

    npm install
    cp .env.example .env
    # Fill in the three Supabase settings in .env
    npm run dev

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

## 4. Deploy on Render Free
Connect this GitHub repository to Render and create the web service from render.yaml. Choose the Free plan. No persistent disk is used; waitlist data is stored in Supabase.

Set these Render environment variables:
- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SECRET_KEY

Do not commit .env or put the secret key in source code. Set it in Render's Environment page.

Render Free web services spin down after 15 minutes without inbound traffic; the first request after sleep may take about a minute. The filesystem is ephemeral, so SQLite is intentionally not used. See https://render.com/docs/free.

## Security notes
- Supabase Auth handles password hashing, email confirmation and browser sessions.
- The browser receives only the publishable key.
- The waitlist table has Row Level Security enabled and no client read/write policies; the backend uses the secret key for waitlist operations.
- The waitlist endpoint has request-rate limiting and a honeypot field.
- Phantom is a wallet connection within an authenticated session, not a substitute for account authentication.
- Google/X OAuth are not enabled in this version.
- Some scanner/holder views may use illustrative or provider-dependent data. Narrative classification remains heuristic, not a validated trading signal.
- Add a privacy policy, terms, monitoring, error reporting and backups before treating this as a production financial product.

Never ask users for seed phrases or private keys.
