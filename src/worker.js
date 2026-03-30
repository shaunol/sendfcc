// sendf.cc — Ephemeral File Sharing Service
// Cloudflare Worker: routing, upload proxy, download redirects, admin dashboard, health monitoring

const PAGES = '%%PAGES%%';
const LOCALE_CODES = Object.keys(PAGES);
const DEFAULT_LOCALE = 'en';
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_UPLOADS_PER_HOUR = 20;
const FILE_TTL_HOURS = 24;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, cacheSecs = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${cacheSecs}`, ...CORS_HEADERS },
  });
}

function ulid() {
  const t = Date.now();
  const E = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  let ts = t;
  for (let i = 9; i >= 0; i--) { s = E[ts & 31] + s; ts = Math.floor(ts / 32); }
  for (let i = 0; i < 16; i++) s += E[Math.floor(Math.random() * 32)];
  return s;
}

function shortId() {
  // 8-char base62 ID for short URLs
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * 62)];
  return id;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Request Analytics ──

function recordHit(env, path, search, country) {
  const date = new Date().toISOString().split('T')[0];
  const full = (search && path.startsWith('/api/')) ? (path + search).slice(0, 200) : path.slice(0, 200);
  return env.DB.prepare(
    'INSERT INTO request_stats (date, path, country, hits) VALUES (?, ?, ?, 1) ON CONFLICT(date, path, country) DO UPDATE SET hits = hits + 1'
  ).bind(date, full, country || '').run();
}

// ── Node Selection ──

async function pickNode(env, continent) {
  const configRaw = await env.NODES.get('config');
  if (!configRaw) return null;
  const nodes = JSON.parse(configRaw);

  // Try to find a healthy node matching the continent
  let best = null;
  let fallback = null;
  for (const node of nodes) {
    const healthRaw = await env.NODES.get(node.id);
    const health = healthRaw ? JSON.parse(healthRaw) : { status: 'unknown' };
    if (health.status !== 'up') continue;
    if (!fallback) fallback = node;
    if (node.continent === continent) {
      if (!best || health.latency < (best._latency || Infinity)) {
        best = node;
        best._latency = health.latency;
      }
    }
  }
  return best || fallback;
}

// ── Upload Handler ──

async function handleUpload(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const token = formData.get('token');

  if (!file || !file.name) return json({ error: 'No file provided' }, 400);
  if (!token) return json({ error: 'Verification token required' }, 400);
  if (file.size > MAX_FILE_SIZE) return json({ error: 'File too large (max 500MB)' }, 400);
  if (file.size === 0) return json({ error: 'Empty file' }, 400);

  // Verify Turnstile
  const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP'),
    }),
  });
  const tsData = await tsRes.json();
  if (!tsData.success) return json({ error: 'Verification failed' }, 403);

  // Rate limit: max uploads per IP per hour
  const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 45);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const rateCheck = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM files WHERE ip = ? AND created_at > ?'
  ).bind(ip, hourAgo).first();
  if (rateCheck && rateCheck.cnt >= MAX_UPLOADS_PER_HOUR) {
    return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
  }

  // Pick storage node
  const continent = (request.cf && request.cf.continent) || 'NA';
  const node = await pickNode(env, continent);
  if (!node) return json({ error: 'No storage nodes available' }, 503);

  // Generate IDs
  const id = shortId();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);

  // Stream file to storage node
  const nodeRes = await fetch(node.url + '/files/' + id + '/' + safeName, {
    method: 'PUT',
    body: file.stream(),
    headers: {
      'X-Upload-Key': env.UPLOAD_KEY,
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': String(file.size),
    },
  });

  if (!nodeRes.ok) {
    return json({ error: 'Storage node error' }, 502);
  }

  // Store metadata
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FILE_TTL_HOURS * 3600000);
  const country = (request.headers.get('CF-IPCountry') || '').slice(0, 10);

  await env.DB.prepare(
    'INSERT INTO files (id, node, filename, size, mime, ip, country, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, node.id, safeName, file.size, file.type || '', ip, country, now.toISOString(), expiresAt.toISOString()).run();

  // Notify dashboard
  ctx.waitUntil((async () => {
    try {
      const doId = env.DASHBOARD_HUB.idFromName('singleton');
      await env.DASHBOARD_HUB.get(doId).fetch('https://internal/notify');
    } catch {}
  })());

  return json({
    id,
    url: 'https://sendf.cc/' + id,
    filename: safeName,
    size: file.size,
    expires: expiresAt.toISOString(),
  });
}

// ── Download Redirect ──

async function handleDownload(id, env) {
  const row = await env.DB.prepare(
    'SELECT node, filename, size, mime, expires_at FROM files WHERE id = ?'
  ).bind(id).first();

  if (!row) return json({ error: 'File not found' }, 404);

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    return json({ error: 'File expired' }, 410);
  }

  // Look up node URL
  const configRaw = await env.NODES.get('config');
  const nodes = configRaw ? JSON.parse(configRaw) : [];
  const node = nodes.find(n => n.id === row.node);
  if (!node) return json({ error: 'Storage node unavailable' }, 503);

  // 302 redirect to storage node (CF never proxies file bytes)
  return new Response(null, {
    status: 302,
    headers: {
      'Location': node.url + '/files/' + id + '/' + row.filename,
      'Cache-Control': 'no-cache',
    },
  });
}

// ── Feedback Handler ──

async function handleFeedback(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const body = await request.json();
    const { message, page, token } = body;
    if (!message || !message.trim()) return json({ error: 'Message is required' }, 400);
    if (!token) return json({ error: 'Turnstile token is required' }, 400);
    if (message.length > 2000) return json({ error: 'Message too long' }, 400);

    const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') }),
    });
    const tsData = await tsRes.json();
    if (!tsData.success) return json({ error: 'Verification failed' }, 403);

    const safePage = (page || '/').slice(0, 200);
    const country = (request.headers.get('CF-IPCountry') || '').slice(0, 10);
    const safeMessage = message.trim().slice(0, 2000);

    const langMatch = safePage.match(/^\/([a-z]{2})\//);
    const lang = (langMatch && LOCALE_CODES.includes(langMatch[1])) ? langMatch[1] : DEFAULT_LOCALE;
    await env.DB.prepare('INSERT INTO feedback (page, lang, country, message) VALUES (?, ?, ?, ?)').bind(safePage, lang, country, safeMessage).run();

    ctx.waitUntil(
      fetch('https://ntfy2.com/sendf-fb-k9w2r', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Title': 'sendf.cc feedback', 'Tags': 'speech_balloon' },
        body: safePage + '\n' + safeMessage.slice(0, 500),
      }).catch(() => {})
    );

    return json({ ok: true });
  } catch (err) {
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Admin Dashboard ──

async function renderDashboardBody(env, url) {
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const filterPath = url.searchParams.get('path') || '';
  const filterCountry = url.searchParams.get('country') || '';
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  let where = 'date >= ?';
  const baseParams = [since];
  if (filterPath) { where += ' AND path = ?'; baseParams.push(filterPath); }
  if (filterCountry) { where += ' AND country = ?'; baseParams.push(filterCountry); }
  const whereNoEmpty = where + (filterCountry ? '' : " AND country != ''");

  const [totalHits, topPaths, topCountries, dailyHits, feedbackCount, fileStats] = await Promise.all([
    env.DB.prepare('SELECT SUM(hits) as total FROM request_stats WHERE ' + where).bind(...baseParams).first(),
    env.DB.prepare('SELECT path, SUM(hits) as total FROM request_stats WHERE ' + where + ' GROUP BY path ORDER BY total DESC LIMIT 30').bind(...baseParams).all(),
    env.DB.prepare('SELECT country, SUM(hits) as total FROM request_stats WHERE ' + whereNoEmpty + ' GROUP BY country ORDER BY total DESC LIMIT 20').bind(...baseParams).all(),
    env.DB.prepare('SELECT date, SUM(hits) as total FROM request_stats WHERE ' + where + ' GROUP BY date ORDER BY date DESC LIMIT 30').bind(...baseParams).all(),
    env.DB.prepare('SELECT COUNT(*) as total FROM feedback').first(),
    env.DB.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(size),0) as total_size FROM files WHERE expires_at > datetime("now")').first(),
  ]);

  const total = totalHits?.total || 0;
  const paths = topPaths?.results || [];
  const countries = topCountries?.results || [];
  const daily = (dailyHits?.results || []).reverse();
  const fbTotal = feedbackCount?.total || 0;
  const apiHits = paths.filter(p => p.path.startsWith('/api/') || p.path === '/upload').reduce((s, p) => s + p.total, 0);
  const pageHits = total - apiHits;
  const activeFiles = fileStats?.cnt || 0;
  const totalSize = fileStats?.total_size || 0;

  function adminQs(overrides) {
    const p = new URLSearchParams();
    const d = overrides.days !== undefined ? overrides.days : days;
    const fp = overrides.path !== undefined ? overrides.path : filterPath;
    const fc = overrides.country !== undefined ? overrides.country : filterCountry;
    if (d && d !== 7) p.set('days', d);
    if (fp) p.set('path', fp);
    if (fc) p.set('country', fc);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  const maxDaily = Math.max(...daily.map(d => d.total), 1);
  const sparkW = 100, sparkH = 32;
  const sparkPoints = daily.map((d, i) => {
    const x = daily.length > 1 ? (i / (daily.length - 1)) * sparkW : sparkW / 2;
    const y = sparkH - (d.total / maxDaily) * (sparkH - 4) - 2;
    return x + ',' + y;
  }).join(' ');

  const filterBanner = (filterPath || filterCountry) ? `
  <div style="background:var(--accent-light);border:1px solid var(--accent);border-radius:8px;padding:0.5rem 0.75rem;margin-bottom:1rem;font-family:var(--mono);font-size:0.8rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
    <span style="color:var(--text-muted);">Filtered by:</span>
    ${filterPath ? '<span style="background:var(--surface);padding:0.15rem 0.5rem;border-radius:4px;">' + esc(filterPath) + '</span>' : ''}
    ${filterCountry ? '<span class="badge badge-country">' + esc(filterCountry) + '</span>' : ''}
    <a href="/admin${adminQs({path: '', country: ''})}" style="color:var(--accent);margin-left:auto;">Clear</a>
  </div>` : '';

  return `
  <h1>Dashboard</h1>
  <p class="subtitle"><span class="live-dot"></span>sendf.cc &mdash; <a href="/admin/feedback">feedback</a></p>

  <div class="ext-links">
    <a href="https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Asendf.cc" target="_blank" rel="noopener">Google</a>
    <a href="https://www.bing.com/webmasters?siteUrl=https://sendf.cc/" target="_blank" rel="noopener">Bing</a>
    <a href="https://dash.cloudflare.com/654cd17f3ff93758038d6dea13b23d64/sendf.cc" target="_blank" rel="noopener">CF Domain</a>
    <a href="https://dash.cloudflare.com/654cd17f3ff93758038d6dea13b23d64/workers/services/view/sendfcc/production" target="_blank" rel="noopener">CF Worker</a>
  </div>

  <div class="range-btns">
    ${[1, 7, 30, 90].map(d => `<a href="/admin${adminQs({days: d})}" class="${d === days ? 'active' : ''}">${d === 1 ? 'Today' : d + 'd'}</a>`).join('')}
  </div>

  ${filterBanner}

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Requests (${days}d)</div><div class="num">${total.toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Uploads</div><div class="num">${apiHits.toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Page views</div><div class="num">${pageHits.toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">Active files</div><div class="num green">${activeFiles}</div></div>
    <div class="stat-card"><div class="label">Storage</div><div class="num">${formatBytes(totalSize)}</div></div>
    <div class="stat-card"><div class="label">Countries</div><div class="num green">${countries.length}</div></div>
  </div>

  ${daily.length > 1 ? `
  <svg class="sparkline" width="100%" height="40" viewBox="0 0 ${sparkW} ${sparkH}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#0d9488" stroke-width="1.5" points="${sparkPoints}" />
    <polyline fill="rgba(13,148,136,0.1)" stroke="none" points="0,${sparkH} ${sparkPoints} ${sparkW},${sparkH}" />
  </svg>` : ''}

  <h2>Popular Routes</h2>
  ${paths.length === 0 ? '<div class="empty">No data yet</div>' : `
  <table>
    <thead><tr><th>Path</th><th class="right">Hits</th><th></th></tr></thead>
    <tbody>
      ${paths.map(p => {
        const pct = total > 0 ? (p.total / total * 100) : 0;
        const isActive = filterPath === p.path;
        return `<tr${isActive ? ' style="background:var(--accent-light)"' : ''}>
          <td class="td-path" data-label="Path"><a href="/admin${adminQs({path: isActive ? '' : p.path})}">${esc(p.path)}</a></td>
          <td class="td-hits" data-label="Hits">${p.total.toLocaleString()}</td>
          <td class="td-bar"><div class="bar" style="width:${pct}%"></div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`}

  <h2>Top Countries</h2>
  ${countries.length === 0 ? '<div class="empty">No data yet</div>' : `
  <table>
    <thead><tr><th>Country</th><th class="right">Hits</th><th></th></tr></thead>
    <tbody>
      ${countries.map(c => {
        const pct = total > 0 ? (c.total / total * 100) : 0;
        const isActive = filterCountry === c.country;
        return `<tr${isActive ? ' style="background:var(--green-light)"' : ''}>
          <td data-label="Country"><a class="badge badge-country" href="/admin${adminQs({country: isActive ? '' : c.country})}">${esc(c.country)}</a></td>
          <td class="td-hits" data-label="Hits">${c.total.toLocaleString()}</td>
          <td class="td-bar"><div class="bar" style="width:${pct}%"></div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`}

  <h2>Daily Breakdown</h2>
  ${daily.length === 0 ? '<div class="empty">No data yet</div>' : `
  <table>
    <thead><tr><th>Date</th><th class="right">Hits</th><th></th></tr></thead>
    <tbody>
      ${daily.map(d => {
        const pct = maxDaily > 0 ? (d.total / maxDaily * 100) : 0;
        return `<tr>
          <td class="td-path" data-label="Date">${esc(d.date)}</td>
          <td class="td-hits" data-label="Hits">${d.total.toLocaleString()}</td>
          <td class="td-bar"><div class="bar" style="width:${pct}%"></div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`}`;
}

// ── DashboardHub Durable Object ──

export class DashboardHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pendingBroadcast = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment(url.search || '');
      try {
        const body = await renderDashboardBody(this.env, url);
        server.send(JSON.stringify({ html: body }));
      } catch (e) {}
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/notify') {
      if (!this.pendingBroadcast) {
        this.pendingBroadcast = true;
        this.state.storage.setAlarm(Date.now() + 1000);
      }
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    this.pendingBroadcast = false;
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        const params = ws.deserializeAttachment() || '';
        const url = new URL('https://internal/admin' + params);
        const body = await renderDashboardBody(this.env, url);
        ws.send(JSON.stringify({ html: body }));
      } catch (e) { try { ws.close(); } catch (_) {} }
    }
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      if (data.params !== undefined) {
        ws.serializeAttachment(data.params);
        const url = new URL('https://internal/admin' + data.params);
        const body = await renderDashboardBody(this.env, url);
        ws.send(JSON.stringify({ html: body }));
      }
    } catch (e) {}
  }

  webSocketClose() {}
  webSocketError(ws) { try { ws.close(); } catch (_) {} }
}

// ── Admin Dashboard Page Shell ──

async function handleAdminDashboard(env, url) {
  const body = await renderDashboardBody(env, url);
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard &mdash; sendf.cc admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --green-light:#f0fdf4; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; padding:2rem 1rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-weight:700; font-size:1.6rem; margin-bottom:0.25rem; }
  h2 { font-weight:600; font-size:1.1rem; margin:1.5rem 0 0.75rem; }
  .subtitle { color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem; }
  .subtitle a { color:var(--accent); text-decoration:none; }
  .subtitle a:hover { text-decoration:underline; }
  .stats-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:0.75rem; margin-bottom:0.5rem; }
  .stat-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:1rem; }
  .stat-card .label { font-family:var(--mono); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); margin-bottom:0.3rem; }
  .stat-card .num { font-family:var(--mono); font-size:1.8rem; font-weight:500; color:var(--accent); }
  .stat-card .num.green { color:var(--green); }
  .range-btns { display:flex; gap:0.35rem; margin-bottom:1.25rem; }
  .range-btns a { font-family:var(--mono); font-size:0.72rem; padding:0.25rem 0.6rem; border:1px solid var(--border); border-radius:6px; text-decoration:none; color:var(--text-muted); }
  .range-btns a.active, .range-btns a:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; margin-bottom:1rem; }
  thead th { text-align:left; padding:0.5rem 0.75rem; font-family:var(--mono); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); border-bottom:2px solid var(--border); font-weight:500; white-space:nowrap; }
  thead th.right { text-align:right; }
  tbody td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--border); vertical-align:top; }
  tbody tr:hover { background:var(--accent-light); }
  .td-path { font-family:var(--mono); font-size:0.8rem; }
  .td-path a { color:var(--text); text-decoration:none; }
  .td-path a:hover { color:var(--accent); }
  .td-hits { font-family:var(--mono); font-size:0.8rem; text-align:right; font-weight:500; }
  .td-bar { width:40%; }
  .bar { height:16px; background:var(--accent); border-radius:3px; opacity:0.2; }
  .badge { display:inline-block; padding:0.1rem 0.45rem; border-radius:4px; font-family:var(--mono); font-size:0.7rem; text-decoration:none; }
  .badge-country { background:var(--green-light); color:var(--green); }
  a.badge:hover { opacity:0.7; }
  .sparkline { display:block; margin-top:0.25rem; }
  .empty { text-align:center; padding:2rem; color:var(--text-muted); font-family:var(--mono); font-size:0.85rem; }
  .ext-links { display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1.25rem; }
  .ext-links a { font-family:var(--mono); font-size:0.7rem; padding:0.25rem 0.6rem; border:1px solid var(--border); border-radius:6px; text-decoration:none; color:var(--text-muted); background:var(--surface); }
  .ext-links a:hover { border-color:var(--accent); color:var(--accent); }
  .live-dot { display:inline-block; width:7px; height:7px; background:var(--green); border-radius:50%; margin-right:0.35rem; animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @media(max-width:700px) {
    .stats-grid { grid-template-columns:repeat(2, 1fr); }
    table, thead, tbody, tr, td, th { display:block; }
    thead { display:none; }
    tbody tr { padding:0.6rem; margin-bottom:0.5rem; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
    tbody td { padding:0.15rem 0; border:none; }
    tbody td::before { content:attr(data-label); font-family:var(--mono); font-size:0.65rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); display:block; margin-bottom:0.1rem; }
    .td-bar { display:none; }
  }
</style>
</head>
<body>
<div class="wrap">${body}</div>
<script>
(function(){
  var ws, retry = 0;
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/admin/ws' + location.search);
    ws.onopen = function() { retry = 0; };
    ws.onmessage = function(e) {
      try { var d = JSON.parse(e.data); if (d.html) document.querySelector('.wrap').innerHTML = d.html; } catch(err) {}
    };
    ws.onclose = function() { var delay = Math.min(1000 * Math.pow(2, retry++), 30000); setTimeout(connect, delay); };
  }
  connect();
})();
</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Admin Feedback Page ──

async function handleAdminFeedback(env, url) {
  const page = url.searchParams.get('page') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  let where = [];
  let params = [];
  if (page) { where.push('page LIKE ?'); params.push('%' + page + '%'); }
  const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const countResult = await env.DB.prepare('SELECT COUNT(*) as total FROM feedback' + whereClause).bind(...params).first();
  const total = countResult?.total || 0;
  const rows = await env.DB.prepare('SELECT * FROM feedback' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(...params, limit, offset).all();
  const feedback = rows.results || [];

  const prevOffset = Math.max(offset - limit, 0);
  const nextOffset = offset + limit;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  function buildQs(overrides) {
    const p = new URLSearchParams();
    if (overrides.page !== undefined ? overrides.page : page) p.set('page', overrides.page !== undefined ? overrides.page : page);
    p.set('limit', String(overrides.limit !== undefined ? overrides.limit : limit));
    if (overrides.offset !== undefined ? overrides.offset : offset) p.set('offset', String(overrides.offset !== undefined ? overrides.offset : offset));
    const s = p.toString();
    return s ? '?' + s : '';
  }

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Feedback &mdash; sendf.cc admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --green-light:#f0fdf4; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; padding:2rem 1rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-weight:700; font-size:1.6rem; margin-bottom:0.25rem; }
  .subtitle { color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem; }
  .subtitle a { color:var(--accent); text-decoration:none; }
  .subtitle a:hover { text-decoration:underline; }
  .filters { display:flex; gap:0.5rem; margin-bottom:1.25rem; flex-wrap:wrap; align-items:end; }
  .filters label { font-family:var(--mono); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); font-weight:500; display:block; margin-bottom:0.2rem; }
  .filters input, .filters select { padding:0.4rem 0.6rem; border:1.5px solid var(--border); border-radius:8px; font-family:var(--mono); font-size:0.82rem; background:var(--surface); color:var(--text); }
  .filters button { padding:0.4rem 1rem; background:var(--accent); color:#fff; border:none; border-radius:8px; font-family:var(--mono); font-size:0.82rem; cursor:pointer; }
  .stats { font-family:var(--mono); font-size:0.78rem; color:var(--text-muted); margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  thead th { text-align:left; padding:0.5rem 0.75rem; font-family:var(--mono); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); border-bottom:2px solid var(--border); font-weight:500; }
  tbody td { padding:0.6rem 0.75rem; border-bottom:1px solid var(--border); vertical-align:top; }
  tbody tr:hover { background:var(--accent-light); }
  .td-id { font-family:var(--mono); font-size:0.78rem; color:var(--text-muted); }
  .td-page { font-family:var(--mono); font-size:0.78rem; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .td-country { font-family:var(--mono); font-size:0.78rem; text-align:center; }
  .td-message { max-width:380px; line-height:1.45; word-break:break-word; }
  .td-date { font-family:var(--mono); font-size:0.75rem; color:var(--text-muted); white-space:nowrap; }
  .empty { text-align:center; padding:3rem 1rem; color:var(--text-muted); font-family:var(--mono); font-size:0.88rem; }
  .pagination { display:flex; gap:0.5rem; margin-top:1.25rem; align-items:center; justify-content:center; }
  .pagination a, .pagination span { font-family:var(--mono); font-size:0.82rem; padding:0.35rem 0.75rem; border-radius:8px; text-decoration:none; }
  .pagination a { color:var(--accent); border:1.5px solid var(--border); }
  .pagination a:hover { border-color:var(--accent); background:var(--accent-light); }
  .pagination .current { color:var(--text); background:var(--surface); border:1.5px solid var(--border); font-weight:500; }
  .badge { display:inline-block; padding:0.1rem 0.4rem; border-radius:4px; font-family:var(--mono); font-size:0.7rem; }
  .badge-country { background:var(--green-light); color:var(--green); }
  @media(max-width:700px) {
    table, thead, tbody, tr, td, th { display:block; }
    thead { display:none; }
    tbody tr { padding:0.75rem; margin-bottom:0.75rem; background:var(--surface); border:1.5px solid var(--border); border-radius:10px; }
    tbody td { padding:0.2rem 0; border:none; }
    tbody td::before { content:attr(data-label); font-family:var(--mono); font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); display:block; margin-bottom:0.15rem; }
    .td-page, .td-message { max-width:none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Feedback</h1>
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a></p>
  <form class="filters" method="GET" action="/admin/feedback">
    <div><label for="fPage">Page</label><input type="text" id="fPage" name="page" value="${esc(page)}" placeholder="/"></div>
    <div><label for="fLimit">Per page</label><select id="fLimit" name="limit">${[25,50,100,200].map(n => `<option value="${n}"${limit === n ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    <button type="submit">Filter</button>
    ${page ? '<a href="/admin/feedback" style="padding:0.4rem 1rem;border-radius:8px;font-family:var(--mono);font-size:0.82rem;text-decoration:none;color:var(--text-muted);border:1.5px solid var(--border);display:inline-block;">Clear</a>' : ''}
  </form>
  <div class="stats">${total} result${total !== 1 ? 's' : ''} &middot; page ${currentPage} of ${Math.max(totalPages, 1)}</div>
  ${feedback.length === 0 ? '<div class="empty">No feedback yet.</div>' : `
  <table><thead><tr><th>#</th><th>Page</th><th>Country</th><th>Message</th><th>Date</th></tr></thead>
  <tbody>${feedback.map(r => `<tr>
    <td class="td-id" data-label="#">${r.id}</td>
    <td class="td-page" data-label="Page" title="${esc(r.page)}">${esc(r.page)}</td>
    <td class="td-country" data-label="Country"><span class="badge badge-country">${esc(r.country) || '&mdash;'}</span></td>
    <td class="td-message" data-label="Message">${esc(r.message)}</td>
    <td class="td-date" data-label="Date">${r.created_at || ''}</td>
  </tr>`).join('')}</tbody></table>`}
  ${totalPages > 1 ? `<div class="pagination">
    ${offset > 0 ? `<a href="/admin/feedback${buildQs({offset: prevOffset})}">&larr; Prev</a>` : ''}
    <span class="current">${currentPage} / ${totalPages}</span>
    ${nextOffset < total ? `<a href="/admin/feedback${buildQs({offset: nextOffset})}">Next &rarr;</a>` : ''}
  </div>` : ''}
</div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Language Detection ──

function detectLanguage(request) {
  const accept = request.headers.get('Accept-Language') || '';
  const primary = accept.split(',')[0].split(';')[0].trim().split('-')[0].toLowerCase();
  if (primary && LOCALE_CODES.includes(primary)) return primary;
  return null;
}

function html(body, lang, request) {
  let page = body;
  const suggested = detectLanguage(request);
  if (suggested && suggested !== lang) {
    page = page.replace(`<html lang=`, `<html data-suggest-lang="${suggested}" lang=`);
  }
  return new Response(page, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}

// ── Main Worker ──

export default {
  async scheduled(event, env, ctx) {
    // Health check all storage nodes
    const configRaw = await env.NODES.get('config');
    if (configRaw) {
      const nodes = JSON.parse(configRaw);
      for (const node of nodes) {
        const start = Date.now();
        try {
          const r = await fetch(node.url + '/health', { signal: AbortSignal.timeout(5000) });
          const body = await r.text().catch(() => '');
          await env.NODES.put(node.id, JSON.stringify({
            status: r.ok ? 'up' : 'down',
            latency: Date.now() - start,
            info: body.slice(0, 200),
            checked: Date.now(),
          }));
        } catch {
          await env.NODES.put(node.id, JSON.stringify({ status: 'down', checked: Date.now() }));
        }
      }
    }
    // Clean expired files from D1
    await env.DB.prepare('DELETE FROM files WHERE expires_at < datetime("now")').run().catch(() => {});
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Fire-and-forget request logging (skip admin)
    if (!path.startsWith('/admin')) {
      const country = request.headers.get('CF-IPCountry') || '';
      ctx.waitUntil(
        recordHit(env, path, url.search, country)
          .then(() => {
            const id = env.DASHBOARD_HUB.idFromName('singleton');
            return env.DASHBOARD_HUB.get(id).fetch('https://internal/notify');
          })
          .catch(() => {})
      );
    }

    // Upload
    if (path === '/upload' && request.method === 'POST') {
      return handleUpload(request, env, ctx);
    }

    // Feedback API
    if (path === '/api/feedback' && request.method === 'POST') {
      return handleFeedback(request, env, ctx);
    }

    // Admin WebSocket (DO)
    if (path === '/admin/ws') {
      const id = env.DASHBOARD_HUB.idFromName('singleton');
      const stub = env.DASHBOARD_HUB.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/connect';
      return stub.fetch(new Request(doUrl, request));
    }

    // Admin dashboard
    if (path === '/admin' || path === '/admin/') {
      return handleAdminDashboard(env, url);
    }

    // Admin feedback
    if (path === '/admin/feedback') {
      return handleAdminFeedback(env, url);
    }

    // Homepage (default locale)
    if (path === '/' || path === '') {
      return html(PAGES[DEFAULT_LOCALE], DEFAULT_LOCALE, request);
    }

    // Localized homepage: /th/, /ja/, /de/, /fr/, /es/
    const localeHomeMatch = path.match(/^\/([a-z]{2})\/?$/);
    if (localeHomeMatch && PAGES[localeHomeMatch[1]]) {
      return html(PAGES[localeHomeMatch[1]], localeHomeMatch[1], request);
    }

    // Static assets
    if (path === '/robots.txt' || path === '/favicon.ico' || path.startsWith('/public/')) {
      const assetUrl = new URL(request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Download redirect — any path that looks like a file ID (6-10 alphanumeric chars)
    const idMatch = path.match(/^\/([A-Za-z0-9]{6,10})$/);
    if (idMatch) {
      return handleDownload(idMatch[1], env);
    }

    // 404
    return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Not Found &mdash; sendf.cc</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}</style>
</head><body><h1>404</h1><p>This file doesn&rsquo;t exist or has expired.</p>
<div class="links"><a href="/">Upload a file</a></div></body></html>`, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};
