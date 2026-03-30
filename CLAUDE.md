# sendf.cc — Project Guidelines

## What this is
A free, ephemeral file sharing service at sendf.cc. Users upload a file (no signup), get a short URL, the file auto-deletes after 24 hours. Hosted on Cloudflare Workers with VPS storage nodes.

## Architecture
- **Single Cloudflare Worker** handles routing, upload proxy, download redirects, admin dashboard, feedback, i18n, and node health/bandwidth monitoring.
- **Cloudflare D1** stores file metadata, feedback, request analytics, and node bandwidth history.
- **Cloudflare KV** (`NODES`) stores node config, health status, and bandwidth rate data.
- **DashboardHub Durable Object** provides real-time WebSocket push updates to the admin dashboard. Refreshes every 5 seconds for live bandwidth monitoring. Broadcasts immediately on request notifications (1-second debounce).
- **Storage nodes** are cheap VPS boxes running Debian + nginx with WebDAV. Worker streams uploads to nodes and redirects downloads directly to them (CF never proxies file bytes — TOS safe).
- **Files expire after 24 hours.** Nodes clean up via hourly cron (`find -mmin +1440 -delete`); D1 metadata cleaned by Worker cron.
- **Node stats daemon** (`sendf-stats.sh`) runs on each node, writes `/proc/net/dev` counters + disk stats to `/var/www/stats.json` every 2 seconds. nginx serves it at `/stats`.

## Build system
- `build.js` reads `src/worker.js`, `src/index.html`, and all `src/locales/*.json` files.
- For each locale, stamps `{{key}}` placeholders in the template with locale values.
- Generates hreflang tags, OG locale alternates, language picker options, and JS runtime strings per locale.
- Outputs all localized HTML pages embedded in a single `dist/worker.js` via `%%PAGES%%` placeholder.
- Zero npm dependencies. Single `node build.js` command.
- Run `node build.js` after any change to templates or locales.

## API routes
- `GET /` — Homepage (default locale upload UI)
- `GET /{locale}/` — Localized homepage (th, ja, de, fr, es)
- `POST /upload` — Upload file (multipart/form-data, Turnstile protected, rate limited 20/IP/hour)
- `GET /{id}` — Download redirect (302 to storage node, 8-char alphanumeric ID)
- `POST /api/feedback` — Submit feedback (Turnstile protected)
- `GET /admin` — Analytics dashboard (WebSocket live via DO, hourly + daily charts, node bandwidth)
- `GET /admin/feedback` — Feedback viewer with pagination
- `GET /admin/files` — File list with status, node, country, pagination
- `GET /admin/file/{id}` — File detail with fingerprint (IP, country), download link, delete
- `DELETE /admin/api/file/{id}` — Delete file from storage node + D1
- `GET /admin/ws` — WebSocket endpoint (proxied to DashboardHub DO)
- Cron (every 5 min) — Health check nodes, store bandwidth snapshots, clean expired D1 rows

## D1 tables
- **files** — File metadata
  - Schema: `id TEXT PRIMARY KEY, node TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT DEFAULT '', ip TEXT DEFAULT '', country TEXT DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL`
  - 24-hour TTL, cleaned by cron
- **feedback** — User feedback submissions
  - Schema: `id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT, lang TEXT, country TEXT, message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **request_stats** — Aggregated request counts per (date, hour, path, country)
  - Schema: `date TEXT NOT NULL, hour TEXT NOT NULL DEFAULT '00', path TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, hour, path, country)`
  - Hourly data enables per-hour chart on admin dashboard
- **node_bandwidth** — Historical bandwidth snapshots (5-minute resolution)
  - Schema: `ts TEXT NOT NULL, node TEXT NOT NULL, rx_bytes INTEGER NOT NULL, tx_bytes INTEGER NOT NULL, disk_used INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0, PRIMARY KEY (ts, node)`
  - Populated by cron every 5 minutes

## KV namespace: NODES
- Key `config` — JSON array of storage node definitions: `[{ "id": "us1", "url": "https://us1.sendf.cc", "continent": "NA" }]`
- Key `{node-id}` — Health status: `{ "status": "up", "latency": 142, "checked": 1774873506 }`
- Key `bw:{node-id}` — Previous bandwidth reading for rate calculation (used by dashboard DO)
- Key `cron:{node-id}` — Previous bandwidth reading for 5-minute delta storage (used by cron)

## Storage nodes

### Current nodes
| ID | Domain | IP | Location | Provider | Price |
|----|--------|----|----------|----------|-------|
| us1 | us1.sendf.cc | 107.172.114.80 | Los Angeles, CA | ServerHost | $33/yr |

### Node setup
- Debian 12 + nginx-extras (WebDAV module) + Let's Encrypt
- Upload auth via `X-Upload-Key` header (shared secret = `UPLOAD_KEY` Worker secret)
- Provision with `./setup-node.sh <upload_key> <domain>`
- Stats daemon: systemd service `sendf-stats` writes JSON to `/var/www/stats.json` every 2s
- Stats endpoint: `GET /stats` returns `{ ok, ts, iface, rx, tx, disk_total, disk_used, disk_free, files, uptime, load }`
- Health endpoint: `GET /health` returns "ok"
- Cleanup cron: `0 * * * * find /files -type f -mmin +1440 -delete`
- SSH: key-only auth (password disabled), root user
- Firewall: UFW allowing 22/80/443 only

### Adding a new node
1. Provision VPS (Debian 12, 100GB+ disk, 1Gbps unmetered)
2. Point DNS: `A {subdomain}.sendf.cc → {IP}` (CF proxy OFF)
3. Run: `ssh root@{IP}` then `./setup-node.sh {UPLOAD_KEY} {subdomain}.sendf.cc`
4. Update KV config: add `{ "id": "{id}", "url": "https://{subdomain}.sendf.cc", "continent": "{NA|EU|AS}" }`

## Deployment
- **Auto-deploys on push to main** via GitHub integration.
- `npm run deploy` for manual deploys.

### Initial setup (one-time)
1. Create KV namespace: `npx wrangler kv namespace create NODES`
2. Create D1 database: `npx wrangler d1 create sendf-db`
3. Seed D1 tables:
   - `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, node TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT DEFAULT '', ip TEXT DEFAULT '', country TEXT DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`
   - `CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT, lang TEXT, country TEXT, message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
   - `CREATE TABLE IF NOT EXISTS request_stats (date TEXT NOT NULL, hour TEXT NOT NULL DEFAULT '00', path TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, hour, path, country))`
   - `CREATE TABLE IF NOT EXISTS node_bandwidth (ts TEXT NOT NULL, node TEXT NOT NULL, rx_bytes INTEGER NOT NULL, tx_bytes INTEGER NOT NULL, disk_used INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0, PRIMARY KEY (ts, node))`
4. Update `wrangler.jsonc` with KV/D1 IDs
5. Set secrets: `npx wrangler secret put TURNSTILE_SECRET` and `npx wrangler secret put UPLOAD_KEY`
6. Deploy: `npm run deploy`
7. Add node config to KV: `npx wrangler kv key put --namespace-id=XXXX config '[{"id":"us1","url":"https://us1.sendf.cc","continent":"NA"}]'`

## Internationalization (i18n)
- **6 locales:** English (default), Thai, Japanese, German, French, Spanish.
- Each locale JSON has: metadata, page strings (build-time), and `js` object (runtime strings).
- Build-time strings use `{{key}}` syntax. JS runtime strings use `L.key` syntax.
- URL structure: `/` (English), `/th/`, `/ja/`, `/de/`, `/fr/`, `/es/`
- hreflang tags + x-default on all pages.
- Language suggestion via `data-suggest-lang` attribute (Accept-Language detection).
- Language picker `<select>` in footer.

## Admin
- `GET /admin` — Analytics dashboard with hourly + daily bar charts, node bandwidth monitoring, request stats
- `GET /admin/files` — File browser with status, node, country, pagination
- `GET /admin/file/{id}` — File detail with IP fingerprint, direct node link, delete button
- `GET /admin/feedback` — Feedback viewer with filtering and pagination
- Real-time updates via DashboardHub Durable Object + WebSocket (5-second refresh for bandwidth)
- Time range selector: Today, 7d, 30d, 90d with timezone support
- Clickable filter-by-path and filter-by-country
- External links: Google Search Console, Bing Webmasters, CF Domain, CF Worker
- Node status cards: live RX/TX bandwidth, disk usage, file count, uptime, load

## Feedback system
- Cloudflare Turnstile (site key `0x4AAAAAACyDQkFarV18g9f6`) for bot protection.
- `TURNSTILE_SECRET` stored as a Wrangler secret.
- Feedback stored in D1 database.
- Fire-and-forget push notification via ntfy2.com on new feedback.
- Inline form in footer with interaction-only Turnstile (invisible for most users).

## Design system
- **Fonts:** DM Mono (monospace), DM Sans (body)
- **Colors:** Background `#f0fdfa`, Surface `#ffffff`, Text `#134e4a`, Muted `#5f8a87`, Accent `#0d9488`, Accent light `#ccfbf1`, Border `#d1e7e5`, Green `#16a34a`, Red `#dc2626`
- **Layout:** Max-width 520px centered for homepage, 900px for admin

## File structure
```
sendfcc/
├── src/
│   ├── worker.js        # CF Worker (routing, DO, upload, download, admin, health, bandwidth)
│   ├── index.html       # Homepage template with {{placeholders}}
│   └── locales/
│       ├── en.json      # English (default)
│       ├── th.json      # Thai
│       ├── ja.json      # Japanese
│       ├── de.json      # German
│       ├── fr.json      # French
│       └── es.json      # Spanish
├── public/
│   ├── favicon.ico
│   ├── favicon-16x16.png
│   ├── favicon-32x32.png
│   ├── favicon-48x48.png
│   ├── apple-touch-icon.png
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── og-image.png
│   ├── site.webmanifest
│   └── robots.txt
├── build.js             # Stamps locales into template, outputs dist/worker.js
├── setup-node.sh        # VPS provisioning script (nginx + WebDAV + SSL + stats daemon)
├── wrangler.jsonc       # Worker config (D1, KV, DO, cron)
├── package.json
├── CLAUDE.md
└── .gitignore
```
