# sendf.cc — Project Guidelines

## What this is
A free, ephemeral file sharing service. Users upload a file, get a short URL, the file auto-deletes after 24 hours. No signup, no accounts. Hosted on Cloudflare Workers with VPS storage nodes.

## Architecture
- **Cloudflare Worker** handles routing, upload proxy, download redirects, admin dashboard, feedback, and node health monitoring.
- **Cloudflare D1** stores file metadata, feedback, and request analytics.
- **Cloudflare KV** (`NODES`) stores storage node health status and configuration.
- **DashboardHub Durable Object** provides real-time WebSocket push updates to the admin dashboard.
- **Storage nodes** are cheap VPS boxes running nginx with WebDAV for uploads. Worker never proxies file bytes — it redirects downloads directly to nodes (CF TOS safe).
- **Files expire after 24 hours.** Nodes clean up via hourly cron; D1 metadata cleaned by Worker cron.

## Build system
- `build.js` reads `src/worker.js` and `src/index.html`.
- Stamps the homepage HTML into the worker via `%%HOMEPAGE%%` placeholder.
- Outputs `dist/worker.js`.
- Zero npm dependencies. Single `node build.js` command.

## Routes
- `GET /` — Homepage (upload UI)
- `POST /upload` — Upload file (multipart, Turnstile protected, rate limited)
- `GET /{id}` — Download redirect (302 to storage node)
- `POST /api/feedback` — Submit feedback (Turnstile protected)
- `GET /admin` — Request analytics dashboard (WebSocket live via DO)
- `GET /admin/feedback` — Feedback viewer
- `GET /admin/ws` — WebSocket endpoint (proxied to DashboardHub DO)
- Cron (every 5 min) — Health check nodes, clean expired D1 rows

## D1 tables
- **files** — File metadata (id, node, filename, size, mime, ip, country, created_at, expires_at)
- **feedback** — User feedback submissions
- **request_stats** — Aggregated request counts per (date, path, country)

## KV namespace: NODES
- Key `config` — JSON array of storage node definitions: `[{ "id": "us-west", "url": "https://us-west.sendf.cc", "continent": "NA" }]`
- Key `{node-id}` — Health status: `{ "status": "up", "latency": 142, "checked": 1774873506 }`

## Storage nodes
- Cheap VPS boxes running Debian + nginx with WebDAV module
- Upload auth via `X-Upload-Key` header (shared secret stored as `UPLOAD_KEY` Worker secret)
- Provision with `./setup-node.sh <upload_key> <domain>`
- Files served at `https://{node}/files/{id}/{filename}`
- Hourly cron deletes files older than 24 hours

## Deployment
- **Auto-deploys on push to main** via GitHub integration.
- `npm run deploy` for manual deploys.

### Initial setup (one-time)
1. Create KV namespace: `npx wrangler kv namespace create NODES`
2. Create D1 database: `npx wrangler d1 create sendf-db`
3. Seed D1 tables:
   - `npx wrangler d1 execute sendf-db --command "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, node TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT DEFAULT '', ip TEXT DEFAULT '', country TEXT DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL)"`
   - `npx wrangler d1 execute sendf-db --command "CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT, lang TEXT, country TEXT, message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"`
   - `npx wrangler d1 execute sendf-db --command "CREATE TABLE IF NOT EXISTS request_stats (date TEXT NOT NULL, path TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, path, country))"`
4. Update `wrangler.jsonc` with KV/D1 IDs
5. Set secrets: `npx wrangler secret put TURNSTILE_SECRET` and `npx wrangler secret put UPLOAD_KEY`
6. Deploy: `npm run deploy`
7. Add node config to KV: `npx wrangler kv key put --namespace-id=XXXX config '[{"id":"us-west","url":"https://us-west.sendf.cc","continent":"NA"}]'`

## Admin
- `GET /admin` — Request analytics dashboard (popular routes, countries, daily breakdown, sparkline)
- `GET /admin/feedback` — Feedback viewer with filtering and pagination
- Real-time updates via DashboardHub Durable Object + WebSocket
- External links: Google Search Console, Bing Webmasters, CF Domain, CF Worker

## Design system
- **Fonts:** DM Mono (monospace), DM Sans (body)
- **Colors:** Background `#f0fdfa`, Surface `#ffffff`, Text `#134e4a`, Muted `#5f8a87`, Accent `#0d9488`, Border `#d1e7e5`
- **Layout:** Max-width 520px centered, single-purpose upload UI

## File structure
```
sendfcc/
├── src/
│   ├── worker.js        # CF Worker (routing, DO, upload, download, admin, health)
│   └── index.html       # Homepage (upload UI)
├── public/
│   ├── favicon.ico
│   └── robots.txt
├── build.js             # Stamps index.html into worker.js
├── setup-node.sh        # VPS provisioning script
├── wrangler.jsonc       # Worker config
├── package.json
├── CLAUDE.md
└── .gitignore
```
