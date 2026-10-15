# MerchMarket admin (private)

A separate app from the public site. It is deployed as its own Vercel project
(`merchmarket-admin`, root directory `admin/`) with **Vercel Authentication on every
deployment** and no custom domain, so only someone signed in to the owner's Vercel
account can even load it. Inside, it has its own login limited to `ADMIN_EMAILS`;
every other request gets a 404 and the dashboard code is never sent.

## Environment variables (Vercel project `merchmarket-admin`)

| Key | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API → service_role (secret) |
| `ADMIN_EMAILS` | your admin email(s), comma-separated |
| `ADMIN_SESSION_SECRET` | a long random string (at least 32 characters) |
| `COMMISSION_RATE` | optional, default `0.12` |

## Run locally

```
cd admin
npm install
SUPABASE_SERVICE_ROLE_KEY=... ADMIN_EMAILS=you@example.com ADMIN_SESSION_SECRET=$(openssl rand -hex 32) npm start
# http://localhost:4000
```

## Database

`backend/migrations/2026-10-14_admin_dashboard.sql` adds the `admin_actions` log and the
admin-only product hide (`products.admin_hidden_at`). Apply it once.
