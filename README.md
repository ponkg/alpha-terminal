# alpha — Solana narrative intelligence

A deployable full-stack MVP based on the supplied alpha terminal prototype.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

SQLite is created at `data/alpha.sqlite` by default. Set `DB_PATH` to a persistent disk path in production.

## Deploy on Render

This repository includes a Render Blueprint. It provisions a Node web service and a 1 GB persistent disk for SQLite. The service is configured on the Starter plan; review the current price and configuration in Render before applying.

## Current MVP limitations

- The prototype login form is demo-only, not secure authentication.
- Phantom connection does not verify a signed message.
- Social OAuth and live X feed integrations are not configured.
- Some scanner/holder views may use illustrative or provider-dependent data.
- Narrative classification is heuristic keyword grouping, not a validated trading signal.
- Add privacy policy, terms, monitoring, error reporting, backups and abuse controls before a public launch.

Never ask users for seed phrases or private keys.
