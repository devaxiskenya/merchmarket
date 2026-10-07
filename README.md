# merchmarket
A platform for clothing brands and thrift stores to connect and interact with fashionisters and thrifters

## Structure

```
frontend/   Everything the browser loads: HTML pages, CSS, client-side JS, images
backend/    Express server (server.js), package.json, database migrations, email templates
vercel.json Deploys backend/server.js and bundles frontend/ with it
```

The backend serves `frontend/` at the site root and hosts the `/api/*` routes, so page URLs
(`/signup.html`, `/merchmarket.js`, ...) are unchanged.

## Local development

```
cd backend
npm install
npm start
```
