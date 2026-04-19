// sendf.cc — Ephemeral File Sharing Service
// Cloudflare Worker: routing, upload proxy, download redirects, admin dashboard, health monitoring

const PAGES = '%%PAGES%%';
const LOCALE_CODES = Object.keys(PAGES);
const DEFAULT_LOCALE = 'en';
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_UPLOADS_PER_HOUR = 20;
const FILE_TTL_HOURS = 24;
const CHUNK_SIZE = 4 * 1024 * 1024;          // 4 MiB per chunk
const UPLOAD_SESSION_TTL_HOURS = 12;         // how long a paused/interrupted upload can be resumed

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
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const full = (search && path.startsWith('/api/')) ? (path + search).slice(0, 200) : path.slice(0, 200);
  return env.DB.prepare(
    'INSERT INTO request_stats (date, hour, path, country, hits) VALUES (?, ?, ?, ?, 1) ON CONFLICT(date, hour, path, country) DO UPDATE SET hits = hits + 1'
  ).bind(date, hour, full, country || '').run();
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
  const ttlHours = Math.min(Math.max(parseInt(formData.get('ttl') || '24', 10), 1), 24);

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

  // Check disk space (reject if >90% full)
  try {
    const statsRes = await fetch(node.url + '/stats', { signal: AbortSignal.timeout(3000) });
    if (statsRes.ok) {
      const stats = await statsRes.json();
      if (stats.disk_total > 0 && stats.disk_used / stats.disk_total > 0.9) {
        return json({ error: 'We\'re a bit overloaded right now. Please try again in an hour.' }, 503);
      }
    }
  } catch {}

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
  const expiresAt = new Date(now.getTime() + ttlHours * 3600000);
  const country = (request.headers.get('CF-IPCountry') || '').slice(0, 10);

  await env.DB.prepare(
    'INSERT INTO files (id, node, filename, size, mime, ip, country, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, node.id, safeName, file.size, file.type || '', ip, country, now.toISOString(), expiresAt.toISOString()).run();

  // Notify dashboard + ntfy2
  ctx.waitUntil((async () => {
    try {
      const doId = env.DASHBOARD_HUB.idFromName('singleton');
      await env.DASHBOARD_HUB.get(doId).fetch('https://internal/notify');
    } catch {}
    await fetch('https://ntfy2.com/sendf-up-k9w2r', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Title': 'sendf.cc upload', 'Tags': 'arrow_up' },
      body: safeName + ' (' + formatBytes(file.size) + ')\n' + country + ' → ' + node.id + ' | https://sendf.cc/' + id,
    }).catch(() => {});
  })());

  return json({
    id,
    url: 'https://sendf.cc/' + id,
    filename: safeName,
    size: file.size,
    expires: expiresAt.toISOString(),
  });
}

// ── Chunked Resumable Upload ──
//
// Flow:
//   POST /upload/init            -> verify Turnstile, rate-limit, pick node, write `uploads` row
//   PUT  /upload/chunk/{id}/{n}  -> proxy chunk to node /chunks/{id}/{n}
//   GET  /upload/status/{id}     -> report which chunks are stored on the node (for resume)
//   POST /upload/complete/{id}   -> tell node to assemble, insert `files` row, return final URL
//   DELETE /upload/{id}          -> cancel/cleanup

async function getUploadSession(env, id) {
  return env.DB.prepare(
    'SELECT id, node, filename, size, mime, ip, country, ttl_hours, total_chunks, chunk_size, created_at, expires_at, completed FROM uploads WHERE id = ?'
  ).bind(id).first();
}

async function getNodeById(env, id) {
  const raw = await env.NODES.get('config');
  const nodes = raw ? JSON.parse(raw) : [];
  return nodes.find(n => n.id === id) || null;
}

async function handleUploadInit(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const filename = typeof body.filename === 'string' ? body.filename : '';
  const size = Number(body.size);
  const mime = typeof body.mime === 'string' ? body.mime : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const ttlHours = Math.min(Math.max(parseInt(body.ttl || '24', 10) || 24, 1), 24);

  if (!filename) return json({ error: 'Missing filename' }, 400);
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'Invalid size' }, 400);
  if (size > MAX_FILE_SIZE) return json({ error: 'File too large (max 500MB)' }, 400);
  if (!token) return json({ error: 'Verification token required' }, 400);

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'file';
  const safeMime = mime.slice(0, 100);

  // Turnstile
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

  // Rate limit across both completed files and in-progress sessions
  const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 45);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const [filesCnt, upCnt] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as cnt FROM files WHERE ip = ? AND created_at > ?').bind(ip, hourAgo).first(),
    env.DB.prepare('SELECT COUNT(*) as cnt FROM uploads WHERE ip = ? AND created_at > ?').bind(ip, hourAgo).first(),
  ]);
  const recent = ((filesCnt && filesCnt.cnt) || 0) + ((upCnt && upCnt.cnt) || 0);
  if (recent >= MAX_UPLOADS_PER_HOUR) {
    return json({ error: 'Rate limit exceeded. Try again later.' }, 429);
  }

  const continent = (request.cf && request.cf.continent) || 'NA';
  const node = await pickNode(env, continent);
  if (!node) return json({ error: 'No storage nodes available' }, 503);

  try {
    const s = await fetch(node.url + '/stats', { signal: AbortSignal.timeout(3000) });
    if (s.ok) {
      const stats = await s.json();
      if (stats.disk_total > 0 && stats.disk_used / stats.disk_total > 0.9) {
        return json({ error: 'We\u2019re a bit overloaded right now. Please try again in an hour.' }, 503);
      }
    }
  } catch {}

  const id = shortId();
  const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const country = (request.headers.get('CF-IPCountry') || '').slice(0, 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_HOURS * 3600000);

  await env.DB.prepare(
    'INSERT INTO uploads (id, node, filename, size, mime, ip, country, ttl_hours, total_chunks, chunk_size, created_at, expires_at, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).bind(id, node.id, safeName, size, safeMime, ip, country, ttlHours, totalChunks, CHUNK_SIZE, now.toISOString(), expiresAt.toISOString()).run();

  return json({
    uploadId: id,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    filename: safeName,
    size,
    ttlHours,
    sessionExpiresAt: expiresAt.toISOString(),
  });
}

async function handleUploadChunk(request, env, uploadId, chunkIndex) {
  const session = await getUploadSession(env, uploadId);
  if (!session) return json({ error: 'Unknown upload' }, 404);
  if (session.completed) return json({ error: 'Upload already completed' }, 409);
  if (new Date(session.expires_at) < new Date()) return json({ error: 'Upload session expired' }, 410);
  if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
    return json({ error: 'Invalid chunk index' }, 400);
  }

  const contentLength = request.headers.get('Content-Length') || '';
  const cl = parseInt(contentLength, 10);
  if (!Number.isFinite(cl) || cl <= 0) return json({ error: 'Content-Length required' }, 411);
  // Max per-chunk payload: chunk_size + some slack. Nginx also caps at 32M.
  if (cl > session.chunk_size + 1024) return json({ error: 'Chunk too large' }, 413);

  const node = await getNodeById(env, session.node);
  if (!node) return json({ error: 'Storage node unavailable' }, 503);

  // Stream the body straight through to the node.
  const nodeRes = await fetch(node.url + '/chunks/' + uploadId + '/' + chunkIndex, {
    method: 'PUT',
    body: request.body,
    headers: {
      'X-Upload-Key': env.UPLOAD_KEY,
      'Content-Type': 'application/octet-stream',
      'Content-Length': contentLength,
    },
  });
  if (!nodeRes.ok) {
    const text = await nodeRes.text().catch(() => '');
    return json({ error: 'Chunk upload failed', status: nodeRes.status, detail: text.slice(0, 200) }, 502);
  }
  return json({ ok: true, n: chunkIndex });
}

async function handleUploadStatus(request, env, uploadId) {
  const session = await getUploadSession(env, uploadId);
  if (!session) return json({ error: 'Unknown upload' }, 404);

  let parts = [];
  let bytes = 0;
  if (!session.completed) {
    const node = await getNodeById(env, session.node);
    if (node) {
      try {
        const r = await fetch(node.url + '/chunks/' + uploadId, {
          headers: { 'X-Upload-Key': env.UPLOAD_KEY },
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const d = await r.json();
          parts = Array.isArray(d.parts) ? d.parts : [];
          bytes = d.bytes || 0;
        }
      } catch {}
    }
  }

  return json({
    uploadId: session.id,
    filename: session.filename,
    size: session.size,
    totalChunks: session.total_chunks,
    chunkSize: session.chunk_size,
    parts,
    bytes,
    completed: !!session.completed,
    expiresAt: session.expires_at,
  });
}

async function handleUploadComplete(request, env, ctx, uploadId) {
  const session = await getUploadSession(env, uploadId);
  if (!session) return json({ error: 'Unknown upload' }, 404);
  if (session.completed) {
    // Idempotent: return the existing file record so the client can resume to the success state.
    const existing = await env.DB.prepare('SELECT id, filename, size, expires_at FROM files WHERE id = ?').bind(uploadId).first();
    if (existing) {
      return json({
        id: existing.id,
        url: 'https://sendf.cc/' + existing.id,
        filename: existing.filename,
        size: existing.size,
        expires: existing.expires_at,
      });
    }
    return json({ error: 'Upload already completed but file missing' }, 409);
  }
  if (new Date(session.expires_at) < new Date()) return json({ error: 'Upload session expired' }, 410);

  const node = await getNodeById(env, session.node);
  if (!node) return json({ error: 'Storage node unavailable' }, 503);

  // Verify all chunks present before asking the node to assemble.
  let parts = [];
  try {
    const sr = await fetch(node.url + '/chunks/' + uploadId, {
      headers: { 'X-Upload-Key': env.UPLOAD_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!sr.ok) return json({ error: 'Node status check failed' }, 502);
    const d = await sr.json();
    parts = Array.isArray(d.parts) ? d.parts : [];
  } catch {
    return json({ error: 'Node unreachable' }, 502);
  }
  if (parts.length !== session.total_chunks) {
    const missing = [];
    const have = new Set(parts);
    for (let i = 0; i < session.total_chunks && missing.length < 50; i++) {
      if (!have.has(i)) missing.push(i);
    }
    return json({ error: 'Missing chunks', have: parts.length, want: session.total_chunks, missing }, 409);
  }

  // Assemble on node. Large files take time — up to 10 minutes.
  const asm = await fetch(node.url + '/assemble/' + uploadId, {
    method: 'POST',
    headers: { 'X-Upload-Key': env.UPLOAD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: session.filename, totalChunks: session.total_chunks }),
    signal: AbortSignal.timeout(600000),
  });
  if (!asm.ok) {
    const text = await asm.text().catch(() => '');
    return json({ error: 'Assembly failed', detail: text.slice(0, 200) }, 502);
  }
  const result = await asm.json().catch(() => ({}));
  const finalSize = Number(result.size) || session.size;
  const finalName = (result.filename || session.filename);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + session.ttl_hours * 3600000);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO files (id, node, filename, size, mime, ip, country, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(uploadId, session.node, finalName, finalSize, session.mime || '', session.ip, session.country, now.toISOString(), expiresAt.toISOString()).run();
  await env.DB.prepare('UPDATE uploads SET completed = 1 WHERE id = ?').bind(uploadId).run();

  ctx.waitUntil((async () => {
    try {
      const doId = env.DASHBOARD_HUB.idFromName('singleton');
      await env.DASHBOARD_HUB.get(doId).fetch('https://internal/notify');
    } catch {}
    await fetch('https://ntfy2.com/sendf-up-k9w2r', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Title': 'sendf.cc upload', 'Tags': 'arrow_up' },
      body: finalName + ' (' + formatBytes(finalSize) + ')\n' + (session.country || '') + ' \u2192 ' + session.node + ' | https://sendf.cc/' + uploadId,
    }).catch(() => {});
  })());

  return json({
    id: uploadId,
    url: 'https://sendf.cc/' + uploadId,
    filename: finalName,
    size: finalSize,
    expires: expiresAt.toISOString(),
  });
}

async function handleUploadAbort(request, env, uploadId) {
  const session = await getUploadSession(env, uploadId);
  if (!session) return json({ ok: true });
  if (!session.completed) {
    const node = await getNodeById(env, session.node);
    if (node) {
      try {
        await fetch(node.url + '/chunks/' + uploadId, {
          method: 'DELETE',
          headers: { 'X-Upload-Key': env.UPLOAD_KEY },
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    }
    await env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId).run();
  }
  return json({ ok: true });
}

// ── Error Page ──

function errorPage(status, heading, message) {
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(heading)} &mdash; sendf.cc</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}.links{display:flex;gap:1.5rem;justify-content:center}</style>
</head><body><div class="brand">sendf<span class="cc">.cc</span></div><h1>${status}</h1><p>${esc(message)}</p>
<div class="links"><a href="/">Upload a file</a></div></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

// ── Download Page ──

async function handleDownload(id, env, request) {
  const row = await env.DB.prepare(
    'SELECT node, filename, size, mime, expires_at FROM files WHERE id = ?'
  ).bind(id).first();

  if (!row) return errorPage(404, 'Not Found', 'This file doesn\u2019t exist or has been removed.');

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    return errorPage(410, 'Expired', 'This file has expired. Files are automatically deleted after 24 hours.');
  }

  // Look up node URL
  const configRaw = await env.NODES.get('config');
  const nodes = configRaw ? JSON.parse(configRaw) : [];
  const node = nodes.find(n => n.id === row.node);
  if (!node) return errorPage(503, 'Unavailable', 'The storage node is temporarily unavailable.');

  // Record download page visit (fire-and-forget)
  const dlIp = (request.headers.get('CF-Connecting-IP') || '').slice(0, 45);
  const dlCountry = (request.headers.get('CF-IPCountry') || '').slice(0, 10);
  const dlUa = (request.headers.get('User-Agent') || '').slice(0, 500);
  const dlReferer = (request.headers.get('Referer') || '').slice(0, 500);
  env.DB.prepare(
    'INSERT INTO file_downloads (file_id, ip, country, ua, referer, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, dlIp, dlCountry, dlUa, dlReferer, new Date().toISOString()).run().catch(() => {});

  const fileUrl = node.url + '/files/' + id + '/' + row.filename;
  const expiresAt = new Date(row.expires_at);
  const remaining = Math.max(0, expiresAt.getTime() - Date.now());
  const hoursLeft = Math.floor(remaining / 3600000);
  const minsLeft = Math.floor((remaining % 3600000) / 60000);
  const timeLeft = hoursLeft > 0 ? hoursLeft + 'h ' + minsLeft + 'm' : minsLeft + 'm';

  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(row.filename)} &mdash; sendf.cc</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>
  :root{--bg:#f0fdfa;--surface:#fff;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--accent-hover:#0f766e;--accent-light:#ccfbf1;--border:#d1e7e5;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}
  [data-theme="dark"]{--bg:#0f1513;--surface:#1a2320;--text:#d1e7e5;--text-muted:#7a9e9a;--accent:#2dd4bf;--accent-hover:#5eead4;--accent-light:#1a2f2b;--border:#2a3f3a;--green:#4ade80;--red:#f87171}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem}
  .container{width:100%;max-width:480px;text-align:center}
  .brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}
  .brand .cc{color:var(--accent)}
  .brand a{color:inherit;text-decoration:none}
  .card{background:var(--surface);border:1.5px solid var(--border);border-radius:16px;padding:1.5rem;text-align:left}
  .file-icon{font-size:2rem;margin-bottom:0.75rem;text-align:center}
  .filename{font-family:var(--mono);font-size:0.92rem;font-weight:500;word-break:break-all;margin-bottom:0.75rem;text-align:center}
  .meta{display:flex;justify-content:center;gap:1.5rem;font-family:var(--mono);font-size:0.78rem;color:var(--text-muted);margin-bottom:1.25rem}
  .dl-btn{display:block;width:100%;padding:0.75rem;background:var(--accent);color:#fff;border:none;border-radius:10px;font-family:var(--mono);font-size:0.95rem;font-weight:500;cursor:pointer;text-align:center;text-decoration:none;transition:background 0.15s}
  [data-theme="dark"] .dl-btn{color:#0f1513}
  .dl-btn:hover{background:var(--accent-hover)}
  .footer-links{margin-top:1.5rem;display:flex;justify-content:center;gap:1.5rem;font-family:var(--mono);font-size:0.82rem}
  .footer-links a{color:var(--accent);text-decoration:none}
  .footer-links a:hover{text-decoration:underline}
  .tagline{margin-top:1.25rem;font-size:0.78rem;color:var(--text-muted);text-align:center}
  .theme-toggle{position:absolute;top:1.25rem;right:1.25rem;background:var(--surface);border:1.5px solid var(--border);border-radius:8px;width:34px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1rem;line-height:1;transition:border-color 0.15s}
  .theme-toggle:hover{border-color:var(--accent)}
</style>
</head><body>
<script>(function(){var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches)document.documentElement.setAttribute('data-theme','dark')})()</script>
<button type="button" class="theme-toggle" id="themeToggle" aria-label="Toggle dark mode"></button>
<div class="container">
  <div class="brand"><a href="/">sendf<span class="cc">.cc</span></a></div>
  <div class="card">
    <div class="file-icon" aria-hidden="true">&#128196;</div>
    <div class="filename">${esc(row.filename)}</div>
    <div class="meta">
      <span>${formatBytes(row.size)}</span>
      <span>Expires in ${timeLeft}</span>
    </div>
    <a class="dl-btn" href="${esc(fileUrl)}" download>Download</a>
  </div>
  <div class="footer-links">
    <a href="/">Upload a file</a>
    <a href="#" id="reportLink" style="color:var(--text-muted);font-size:0.75rem">Report abuse</a>
  </div>
  <div class="tagline">Free temporary file sharing &mdash; files auto-delete after 24 hours</div>
  <div id="reportForm" style="display:none;margin-top:1rem;max-width:480px;width:100%">
    <textarea id="reportMsg" rows="3" placeholder="Describe the issue..." style="width:100%;padding:0.5rem;border:1.5px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:0.82rem;background:var(--surface);color:var(--text);resize:vertical"></textarea>
    <button type="button" id="reportSubmit" style="margin-top:0.35rem;width:100%;padding:0.5rem;background:var(--red,#dc2626);color:#fff;border:none;border-radius:8px;font-family:var(--mono);font-size:0.82rem;cursor:pointer">Submit Report</button>
    <div id="reportStatus" style="font-family:var(--mono);font-size:0.78rem;color:var(--text-muted);text-align:center;margin-top:0.35rem"></div>
  </div>
</div>
<script>
(function(){var btn=document.getElementById('themeToggle');function g(){return document.documentElement.getAttribute('data-theme')||'light'}function s(){btn.textContent=g()==='dark'?'\\u2600':'\\u263E'}s();btn.addEventListener('click',function(){var n=g()==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);localStorage.setItem('theme',n);s()})})();
(function(){var link=document.getElementById('reportLink'),form=document.getElementById('reportForm'),msg=document.getElementById('reportMsg'),sub=document.getElementById('reportSubmit'),st=document.getElementById('reportStatus');link.addEventListener('click',function(e){e.preventDefault();form.style.display=form.style.display==='none'?'block':'none'});sub.addEventListener('click',function(){if(!msg.value.trim())return;sub.disabled=true;st.textContent='Sending...';fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'[ABUSE REPORT] File: ${id}\\n'+msg.value,page:'/${id}',token:''})}).then(function(r){if(r.ok||r.status===403){st.textContent='Report submitted. We will review this file.';form.querySelector('textarea').style.display='none';sub.style.display='none'}else{st.textContent='Failed to submit. Please try again.';sub.disabled=false}}).catch(function(){st.textContent='Failed to submit. Please try again.';sub.disabled=false})})})();
</script>
</body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
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
  const tzo = parseInt(url.searchParams.get('tzo') || '0', 10);
  const offsetH = -Math.round(tzo / 60);
  const since = new Date(Date.now() - (days + 1) * 86400000).toISOString().split('T')[0];

  let where = 'date >= ?';
  const baseParams = [since];
  if (filterPath) { where += ' AND path = ?'; baseParams.push(filterPath); }
  if (filterCountry) { where += ' AND country = ?'; baseParams.push(filterCountry); }
  const whereNoEmpty = where + (filterCountry ? '' : " AND country != ''");

  // Fetch node stats in parallel with DB queries
  const configRaw = await env.NODES.get('config');
  const nodesList = configRaw ? JSON.parse(configRaw) : [];
  const nodeStatsPromises = nodesList.map(async (node) => {
    try {
      const r = await fetch(node.url + '/stats', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return { id: node.id, url: node.url, status: 'down' };
      const stats = await r.json();
      // Calculate bandwidth rate from previous reading
      const prevRaw = await env.NODES.get('bw:' + node.id);
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      let rxRate = 0, txRate = 0;
      if (prev && stats.ts > prev.ts) {
        const dt = stats.ts - prev.ts;
        rxRate = Math.round((stats.rx - prev.rx) / dt);
        txRate = Math.round((stats.tx - prev.tx) / dt);
      }
      // Store current reading for next rate calculation
      await env.NODES.put('bw:' + node.id, JSON.stringify({ ts: stats.ts, rx: stats.rx, tx: stats.tx }));
      return { ...stats, id: node.id, url: node.url, continent: node.continent, status: 'up', rxRate, txRate };
    } catch { return { id: node.id, url: node.url, status: 'down' }; }
  });

  const [totalHits, topPaths, topCountries, allHourly, feedbackCount, fileStats, ...nodeStats] = await Promise.all([
    env.DB.prepare('SELECT SUM(hits) as total FROM request_stats WHERE ' + where).bind(...baseParams).first(),
    env.DB.prepare('SELECT path, SUM(hits) as total FROM request_stats WHERE ' + where + ' GROUP BY path ORDER BY total DESC LIMIT 30').bind(...baseParams).all(),
    env.DB.prepare('SELECT country, SUM(hits) as total FROM request_stats WHERE ' + whereNoEmpty + ' GROUP BY country ORDER BY total DESC LIMIT 20').bind(...baseParams).all(),
    env.DB.prepare('SELECT date, hour, SUM(hits) as total FROM request_stats WHERE ' + where + ' GROUP BY date, hour').bind(...baseParams).all(),
    env.DB.prepare('SELECT COUNT(*) as total FROM feedback').first(),
    env.DB.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(size),0) as total_size FROM files WHERE expires_at > datetime("now")').first(),
    ...nodeStatsPromises,
  ]);

  const total = totalHits?.total || 0;
  const paths = topPaths?.results || [];
  const countries = topCountries?.results || [];
  const fbTotal = feedbackCount?.total || 0;
  const apiHits = paths.filter(p => p.path.startsWith('/api/') || p.path === '/upload').reduce((s, p) => s + p.total, 0);
  const pageHits = total - apiHits;
  const activeFiles = fileStats?.cnt || 0;
  const totalSize = fileStats?.total_size || 0;

  // Shift UTC (date,hour) to local timezone then aggregate
  const localDailyMap = new Map();
  const localHourlyMap = new Map();
  const localNow = new Date(Date.now() + offsetH * 3600000);
  const localToday = localNow.toISOString().split('T')[0];
  for (const r of (allHourly?.results || [])) {
    const utcMs = new Date(r.date + 'T00:00:00Z').getTime() + parseInt(r.hour, 10) * 3600000;
    const localMs = utcMs + offsetH * 3600000;
    const ld = new Date(localMs);
    const localDate = ld.toISOString().split('T')[0];
    const localH = String(ld.getUTCHours()).padStart(2, '0');
    localDailyMap.set(localDate, (localDailyMap.get(localDate) || 0) + r.total);
    if (localDate === localToday) {
      localHourlyMap.set(localH, (localHourlyMap.get(localH) || 0) + r.total);
    }
  }

  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const ds = new Date(localNow.getTime() - i * 86400000).toISOString().split('T')[0];
    daily.push({ date: ds, total: localDailyMap.get(ds) || 0 });
  }
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    hourly.push({ hour: hh, total: localHourlyMap.get(hh) || 0 });
  }

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

  function buildChart(data, labelFn) {
    const W = 300, H = 120;
    const pad = { top: 14, right: 8, bottom: 22, left: 36 };
    const cw = W - pad.left - pad.right;
    const ch = H - pad.top - pad.bottom;
    const max = Math.max(...data.map(d => d.total), 1);
    const n = data.length;
    const gap = n > 15 ? 1 : 2;
    const barW = Math.max((cw - gap * (n - 1)) / n, 1);
    let svg = '';
    for (let i = 0; i <= 3; i++) {
      const val = Math.round(max * i / 3);
      const y = (pad.top + ch - (i / 3) * ch).toFixed(1);
      svg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#d1e7e5" stroke-width="0.5"/>';
      svg += '<text x="' + (pad.left - 4) + '" y="' + (+y + 3).toFixed(1) + '" text-anchor="end" fill="#5f8a87" font-size="7" font-family="DM Mono,monospace">' + val + '</text>';
    }
    data.forEach((d, i) => {
      const barH = max > 0 ? (d.total / max) * ch : 0;
      const x = pad.left + i * (barW + gap);
      const y = pad.top + ch - barH;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + barH.toFixed(1) + '" rx="1" fill="#0d9488" opacity="' + (d.total > 0 ? '0.4' : '0.08') + '"><title>' + labelFn(d) + ': ' + d.total + '</title></rect>';
    });
    const labelCount = n <= 10 ? n : n <= 24 ? 6 : 7;
    const step = Math.max(Math.floor(n / labelCount), 1);
    for (let i = 0; i < n; i += step) {
      const x = pad.left + i * (barW + gap) + barW / 2;
      const rawLabel = labelFn(data[i]);
      const shortLabel = rawLabel.length > 5 ? rawLabel.slice(8) + '/' + rawLabel.slice(5, 7) : rawLabel;
      svg += '<text x="' + x.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" fill="#5f8a87" font-size="6.5" font-family="DM Mono,monospace">' + shortLabel + '</text>';
    }
    svg += '<line x1="' + pad.left + '" y1="' + pad.top + '" x2="' + pad.left + '" y2="' + (pad.top + ch) + '" stroke="#d1e7e5" stroke-width="0.5"/>';
    return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>';
  }

  const hourlyChart = buildChart(hourly, d => d.hour + ':00');
  const dailyChart = daily.length > 0 ? buildChart(daily, d => d.date) : '';

  const filterBanner = (filterPath || filterCountry) ? `
  <div style="background:var(--accent-light);border:1px solid var(--accent);border-radius:8px;padding:0.5rem 0.75rem;margin-bottom:1rem;font-family:var(--mono);font-size:0.8rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
    <span style="color:var(--text-muted);">Filtered by:</span>
    ${filterPath ? '<span style="background:var(--surface);padding:0.15rem 0.5rem;border-radius:4px;">' + esc(filterPath) + '</span>' : ''}
    ${filterCountry ? '<span class="badge badge-country">' + esc(filterCountry) + '</span>' : ''}
    <a href="/admin${adminQs({path: '', country: ''})}" style="color:var(--accent);margin-left:auto;">Clear</a>
  </div>` : '';

  return `
  <h1>Dashboard</h1>
  <p class="subtitle"><span class="live-dot"></span>sendf.cc &mdash; <a href="/admin/feedback">feedback</a> &middot; <a href="/admin/files">files</a> &middot; <a href="/admin/bandwidth">bandwidth</a> &middot; <a href="/admin/speedtest">speed test</a></p>

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

  <div class="chart-row">
    <div class="chart-card">
      <div class="chart-label">Today (hourly)</div>
      ${hourlyChart}
    </div>
    <div class="chart-card">
      <div class="chart-label">Daily (${days}d)</div>
      ${dailyChart || '<div class="empty" style="padding:0.5rem">No data yet</div>'}
    </div>
  </div>

  <h2>Storage Nodes</h2>
  ${nodeStats.length === 0 ? '<div class="empty">No nodes configured</div>' : `
  <div class="nodes-grid">
    ${nodeStats.map(n => `
    <div class="node-card ${n.status === 'up' ? '' : 'node-down'}">
      <div class="node-header">
        <span class="node-dot ${n.status === 'up' ? 'dot-up' : 'dot-down'}"></span>
        <strong>${esc(n.id)}</strong>
        <span class="node-region">${esc(n.continent || '')}</span>
      </div>
      ${n.status === 'up' ? `
      <div class="node-bw">
        <div class="bw-row"><span class="bw-label">&darr; RX</span><span class="bw-val">${formatBytes(n.rxRate || 0)}/s</span></div>
        <div class="bw-row"><span class="bw-label">&uarr; TX</span><span class="bw-val">${formatBytes(n.txRate || 0)}/s</span></div>
      </div>
      <div class="node-meta">
        <span>Disk: ${formatBytes(n.disk_used || 0)} / ${formatBytes(n.disk_total || 0)}</span>
        <span>Files: ${n.files || 0}</span>
        <span>Load: ${esc(String(n.load || '?'))}</span>
        <span>Up: ${esc(n.uptime || '?')}</span>
      </div>
      <div class="bw-totals">
        <span>Total RX: ${formatBytes(n.rx || 0)}</span>
        <span>Total TX: ${formatBytes(n.tx || 0)}</span>
      </div>
      ` : '<div class="node-meta"><span>Node unreachable</span></div>'}
    </div>`).join('')}
  </div>`}

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
  ${daily.length === 0 ? '<div class="empty">No data yet</div>' : (() => {
  const maxDaily = Math.max(...daily.map(d => d.total), 1);
  return `
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
  </table>`;
  })()}`;
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
    if (sockets.length === 0) return;
    for (const ws of sockets) {
      try {
        const params = ws.deserializeAttachment() || '';
        const url = new URL('https://internal/admin' + params);
        const body = await renderDashboardBody(this.env, url);
        ws.send(JSON.stringify({ html: body }));
      } catch (e) { try { ws.close(); } catch (_) {} }
    }
    // Keep refreshing every 5 seconds for live bandwidth monitoring
    if (this.state.getWebSockets().length > 0) {
      this.state.storage.setAlarm(Date.now() + 5000);
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

// ── Bandwidth History Page ──

async function handleAdminBandwidth(env, url) {
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const filterNode = url.searchParams.get('node') || '';
  const tzo = parseInt(url.searchParams.get('tzo') || '0', 10);
  const offsetH = -Math.round(tzo / 60);
  const since = new Date(Date.now() - (days + 1) * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  let where = 'ts >= ?';
  const params = [since];
  if (filterNode) { where += ' AND node = ?'; params.push(filterNode); }

  const rows = await env.DB.prepare(
    'SELECT ts, node, rx_bytes, tx_bytes, disk_used, file_count FROM node_bandwidth WHERE ' + where + ' ORDER BY ts ASC'
  ).bind(...params).all();
  const data = rows?.results || [];

  // Get node list
  const configRaw = await env.NODES.get('config');
  const nodesList = configRaw ? JSON.parse(configRaw) : [];

  // Aggregate by local hour and local day
  const hourlyMap = new Map();
  const dailyMap = new Map();
  const localNow = new Date(Date.now() + offsetH * 3600000);
  const localToday = localNow.toISOString().split('T')[0];

  for (const r of data) {
    const utcMs = new Date(r.ts).getTime();
    const localMs = utcMs + offsetH * 3600000;
    const ld = new Date(localMs);
    const localDate = ld.toISOString().split('T')[0];
    const localH = String(ld.getUTCHours()).padStart(2, '0');

    // Daily
    const dKey = localDate;
    const dEntry = dailyMap.get(dKey) || { rx: 0, tx: 0 };
    dEntry.rx += r.rx_bytes;
    dEntry.tx += r.tx_bytes;
    dailyMap.set(dKey, dEntry);

    // Hourly (today only)
    if (localDate === localToday) {
      const hKey = localH;
      const hEntry = hourlyMap.get(hKey) || { rx: 0, tx: 0 };
      hEntry.rx += r.rx_bytes;
      hEntry.tx += r.tx_bytes;
      hourlyMap.set(hKey, hEntry);
    }
  }

  // Build arrays
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const ds = new Date(localNow.getTime() - i * 86400000).toISOString().split('T')[0];
    const d = dailyMap.get(ds) || { rx: 0, tx: 0 };
    daily.push({ date: ds, rx: d.rx, tx: d.tx });
  }
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    const d = hourlyMap.get(hh) || { rx: 0, tx: 0 };
    hourly.push({ hour: hh, rx: d.rx, tx: d.tx });
  }

  // Totals
  const totalRx = daily.reduce((s, d) => s + d.rx, 0);
  const totalTx = daily.reduce((s, d) => s + d.tx, 0);

  // Latest disk/file stats
  const latestRow = data.length > 0 ? data[data.length - 1] : null;

  function buildBwChart(items, labelFn, getVal) {
    const W = 300, H = 120;
    const pad = { top: 14, right: 8, bottom: 22, left: 42 };
    const cw = W - pad.left - pad.right;
    const ch = H - pad.top - pad.bottom;
    const max = Math.max(...items.map(getVal), 1);
    const n = items.length;
    const gap = n > 15 ? 1 : 2;
    const barW = Math.max((cw - gap * (n - 1)) / n, 1);
    let svg = '';
    for (let i = 0; i <= 3; i++) {
      const val = max * i / 3;
      const y = (pad.top + ch - (i / 3) * ch).toFixed(1);
      svg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#d1e7e5" stroke-width="0.5"/>';
      svg += '<text x="' + (pad.left - 4) + '" y="' + (+y + 3).toFixed(1) + '" text-anchor="end" fill="#5f8a87" font-size="6" font-family="DM Mono,monospace">' + formatBytes(Math.round(val)) + '</text>';
    }
    items.forEach((d, i) => {
      const v = getVal(d);
      const barH = max > 0 ? (v / max) * ch : 0;
      const x = pad.left + i * (barW + gap);
      const y = pad.top + ch - barH;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + barH.toFixed(1) + '" rx="1" fill="#0d9488" opacity="' + (v > 0 ? '0.4' : '0.08') + '"><title>' + labelFn(d) + ': ' + formatBytes(v) + '</title></rect>';
    });
    const labelCount = n <= 10 ? n : n <= 24 ? 6 : 7;
    const step = Math.max(Math.floor(n / labelCount), 1);
    for (let i = 0; i < n; i += step) {
      const x = pad.left + i * (barW + gap) + barW / 2;
      const rawLabel = labelFn(items[i]);
      const shortLabel = rawLabel.length > 5 ? rawLabel.slice(8) + '/' + rawLabel.slice(5, 7) : rawLabel;
      svg += '<text x="' + x.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" fill="#5f8a87" font-size="6.5" font-family="DM Mono,monospace">' + shortLabel + '</text>';
    }
    return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>';
  }

  function adminQs(overrides) {
    const p = new URLSearchParams();
    const d = overrides.days !== undefined ? overrides.days : days;
    const fn = overrides.node !== undefined ? overrides.node : filterNode;
    if (d && d !== 7) p.set('days', d);
    if (fn) p.set('node', fn);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bandwidth &mdash; sendf.cc admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --green-light:#f0fdf4; --red:#dc2626; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
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
  .range-btns { display:flex; gap:0.35rem; margin-bottom:1.25rem; flex-wrap:wrap; }
  .range-btns a { font-family:var(--mono); font-size:0.72rem; padding:0.25rem 0.6rem; border:1px solid var(--border); border-radius:6px; text-decoration:none; color:var(--text-muted); }
  .range-btns a.active, .range-btns a:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
  .node-btns { display:flex; gap:0.35rem; margin-bottom:1.25rem; flex-wrap:wrap; }
  .node-btns a { font-family:var(--mono); font-size:0.72rem; padding:0.25rem 0.6rem; border:1px solid var(--border); border-radius:6px; text-decoration:none; color:var(--text-muted); }
  .node-btns a.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .chart-row { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-bottom:0.5rem; }
  .chart-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:0.75rem; }
  .chart-label { font-family:var(--mono); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); margin-bottom:0.4rem; }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; margin-bottom:1rem; }
  thead th { text-align:left; padding:0.5rem 0.75rem; font-family:var(--mono); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); border-bottom:2px solid var(--border); font-weight:500; }
  thead th.right { text-align:right; }
  tbody td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:0.8rem; }
  tbody tr:hover { background:var(--accent-light); }
  .td-right { text-align:right; }
  @media(max-width:700px) {
    .chart-row { grid-template-columns:1fr; }
    .stats-grid { grid-template-columns:repeat(2, 1fr); }
    table, thead, tbody, tr, td, th { display:block; }
    thead { display:none; }
    tbody tr { padding:0.6rem; margin-bottom:0.5rem; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
    tbody td { padding:0.15rem 0; border:none; }
    tbody td::before { content:attr(data-label); font-family:var(--mono); font-size:0.65rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); display:block; margin-bottom:0.1rem; }
  }
</style>
</head><body>
<div class="wrap">
  <h1>Bandwidth</h1>
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a> &middot; <a href="/admin/feedback">feedback</a> &middot; <a href="/admin/files">files</a> &middot; <a href="/admin/speedtest">speed test</a></p>

  <div class="range-btns">
    ${[1, 7, 30, 90].map(d => `<a href="/admin/bandwidth${adminQs({days: d})}" class="${d === days ? 'active' : ''}">${d === 1 ? 'Today' : d + 'd'}</a>`).join('')}
  </div>

  ${nodesList.length > 1 ? `<div class="node-btns">
    <a href="/admin/bandwidth${adminQs({node: ''})}" class="${!filterNode ? 'active' : ''}">All</a>
    ${nodesList.map(n => `<a href="/admin/bandwidth${adminQs({node: n.id})}" class="${filterNode === n.id ? 'active' : ''}">${esc(n.id)}</a>`).join('')}
  </div>` : ''}

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Total RX (${days}d)</div><div class="num">${formatBytes(totalRx)}</div></div>
    <div class="stat-card"><div class="label">Total TX (${days}d)</div><div class="num">${formatBytes(totalTx)}</div></div>
    <div class="stat-card"><div class="label">Combined</div><div class="num">${formatBytes(totalRx + totalTx)}</div></div>
    ${latestRow ? `<div class="stat-card"><div class="label">Disk Used</div><div class="num">${formatBytes(latestRow.disk_used || 0)}</div></div>
    <div class="stat-card"><div class="label">Files</div><div class="num green">${latestRow.file_count || 0}</div></div>` : ''}
  </div>

  <h2>Today (hourly)</h2>
  <div class="chart-row">
    <div class="chart-card">
      <div class="chart-label">&darr; RX per hour</div>
      ${buildBwChart(hourly, d => d.hour + ':00', d => d.rx)}
    </div>
    <div class="chart-card">
      <div class="chart-label">&uarr; TX per hour</div>
      ${buildBwChart(hourly, d => d.hour + ':00', d => d.tx)}
    </div>
  </div>

  <h2>Daily (${days}d)</h2>
  <div class="chart-row">
    <div class="chart-card">
      <div class="chart-label">&darr; RX per day</div>
      ${buildBwChart(daily, d => d.date, d => d.rx)}
    </div>
    <div class="chart-card">
      <div class="chart-label">&uarr; TX per day</div>
      ${buildBwChart(daily, d => d.date, d => d.tx)}
    </div>
  </div>

  <h2>Daily Breakdown</h2>
  ${daily.length === 0 ? '<div style="text-align:center;color:var(--text-muted);font-family:var(--mono);font-size:0.85rem;padding:2rem;">No data yet</div>' : `
  <table>
    <thead><tr><th>Date</th><th class="right">RX</th><th class="right">TX</th><th class="right">Total</th></tr></thead>
    <tbody>
      ${[...daily].reverse().map(d => `<tr>
        <td data-label="Date">${esc(d.date)}</td>
        <td class="td-right" data-label="RX">${formatBytes(d.rx)}</td>
        <td class="td-right" data-label="TX">${formatBytes(d.tx)}</td>
        <td class="td-right" data-label="Total">${formatBytes(d.rx + d.tx)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`}
</div>
<script>
(function(){
  if (location.search.indexOf('tzo=') === -1) {
    var sep = location.search ? '&' : '?';
    location.replace(location.href + sep + 'tzo=' + new Date().getTimezoneOffset());
  }
})();
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Speed Test ──

async function handleSpeedTestPage(env) {
  const configRaw = await env.NODES.get('config');
  const nodes = configRaw ? JSON.parse(configRaw) : [];

  return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Speed Test &mdash; sendf.cc admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --red:#dc2626; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; padding:2rem 1rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-weight:700; font-size:1.6rem; margin-bottom:0.25rem; }
  .subtitle { color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem; }
  .subtitle a { color:var(--accent); text-decoration:none; }
  .subtitle a:hover { text-decoration:underline; }
  h2 { font-weight:600; font-size:1.1rem; margin:1.5rem 0 0.75rem; }
  .controls { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:1rem; }
  .btn { padding:0.5rem 1.2rem; border:none; border-radius:8px; font-family:var(--mono); font-size:0.85rem; cursor:pointer; background:var(--accent); color:#fff; }
  .btn:hover { opacity:0.85; }
  .btn:disabled { opacity:0.4; cursor:default; }
  .btn-sm { padding:0.3rem 0.7rem; font-size:0.78rem; }
  .btn-sm.active { background:var(--text); }
  .node-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:1.25rem; margin-bottom:0.75rem; }
  .node-header { font-family:var(--mono); font-size:0.9rem; font-weight:600; margin-bottom:1rem; display:flex; align-items:center; gap:0.5rem; }
  .node-region { font-size:0.72rem; color:var(--text-muted); font-weight:400; }
  .gauge-row { display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-bottom:1rem; }
  .gauge { text-align:center; }
  .gauge-label { font-family:var(--mono); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:0.5rem; }
  .gauge-val { font-family:var(--mono); font-size:2.2rem; font-weight:500; color:var(--accent); line-height:1; }
  .gauge-val.measuring { animation:pulse 1s infinite; }
  .gauge-unit { font-family:var(--mono); font-size:0.82rem; color:var(--text-muted); }
  .gauge-sub { font-family:var(--mono); font-size:0.68rem; color:var(--text-muted); margin-top:0.3rem; }
  .stats-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:0.5rem; }
  .stat { background:var(--bg); border-radius:8px; padding:0.5rem 0.65rem; }
  .stat-label { font-family:var(--mono); font-size:0.62rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); }
  .stat-val { font-family:var(--mono); font-size:0.95rem; font-weight:500; color:var(--text); }
  .stat-val.good { color:var(--green); }
  .stat-val.bad { color:var(--red); }
  .live-chart { margin:0.75rem 0; height:60px; display:flex; align-items:end; gap:2px; }
  .live-bar { flex:1; background:var(--accent); opacity:0.3; border-radius:2px 2px 0 0; min-height:1px; transition:height 0.3s; }
  .live-bar.active { opacity:0.6; }
  .phase { font-family:var(--mono); font-size:0.78rem; color:var(--text-muted); margin:0.75rem 0 0.25rem; }
  .progress-bar { width:100%; height:4px; background:var(--border); border-radius:2px; overflow:hidden; margin:0.35rem 0; }
  .progress-fill { height:100%; background:var(--accent); border-radius:2px; width:0%; transition:width 0.2s; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  @media(max-width:500px) { .gauge-row { grid-template-columns:1fr; } .gauge-val { font-size:1.8rem; } }
</style>
</head><body>
<div class="wrap">
  <h1>Speed Test</h1>
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a> &middot; <a href="/admin/feedback">feedback</a> &middot; <a href="/admin/files">files</a> &middot; <a href="/admin/bandwidth">bandwidth</a></p>

  <div class="controls">
    <button class="btn" id="runBtn" onclick="runTest()">Run Speed Test</button>
    <span style="font-family:var(--mono);font-size:0.72rem;color:var(--text-muted)">Threads:</span>
    <button class="btn btn-sm" onclick="setThreads(1)" id="t1">1</button>
    <button class="btn btn-sm active" onclick="setThreads(4)" id="t4">4</button>
    <button class="btn btn-sm" onclick="setThreads(8)" id="t8">8</button>
  </div>

  <div id="results"></div>
</div>

<script>
var NODES = ${JSON.stringify(nodes.map(n => ({ id: n.id, url: n.url, continent: n.continent })))};
var THREADS = 4;
var running = false;

function setThreads(n) {
  THREADS = n;
  [1,4,8].forEach(function(v){ document.getElementById('t'+v).className = 'btn btn-sm' + (v===n?' active':''); });
}

function fmtSpeed(bps) {
  if (bps >= 1e9) return { val:(bps/1e9).toFixed(1), unit:'Gbps' };
  if (bps >= 1e6) return { val:(bps/1e6).toFixed(1), unit:'Mbps' };
  if (bps >= 1e3) return { val:(bps/1e3).toFixed(1), unit:'Kbps' };
  return { val:bps.toFixed(0), unit:'bps' };
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b/1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b/1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b/1024).toFixed(1) + ' KB';
  return b + ' B';
}

function clsLatency(ms) { return ms < 50 ? 'good' : ms < 200 ? '' : 'bad'; }

// Measure latency with multiple pings
async function measureLatency(url, count) {
  var times = [];
  for (var i = 0; i < count; i++) {
    try {
      var t0 = performance.now();
      await fetch(url + '/health', { mode:'cors', cache:'no-store' });
      times.push(performance.now() - t0);
    } catch(e) { times.push(-1); }
  }
  var valid = times.filter(function(t){ return t >= 0; });
  if (!valid.length) return { min:-1, avg:-1, max:-1, jitter:0 };
  valid.sort(function(a,b){ return a-b; });
  var avg = valid.reduce(function(s,v){ return s+v; }, 0) / valid.length;
  var jitter = valid.length > 1 ? Math.sqrt(valid.reduce(function(s,v){ return s + (v-avg)*(v-avg); }, 0) / valid.length) : 0;
  return { min:Math.round(valid[0]), avg:Math.round(avg), max:Math.round(valid[valid.length-1]), jitter:Math.round(jitter) };
}

// Multi-threaded download test with progress tracking
async function measureDownload(url, threads, updateFn) {
  // Use 10MB file per thread, so 4 threads = 40MB total
  var fileUrl = url + '/speedtest-10mb.bin';
  var fileSize = 10485760;
  var totalBytes = 0;
  var samples = [];
  var startTime = performance.now();
  var lastSample = startTime;

  function sampleTick() {
    var now = performance.now();
    var elapsed = now - startTime;
    if (elapsed > 0) {
      var bps = (totalBytes * 8 * 1000) / elapsed;
      samples.push({ t: elapsed, bps: bps });
      updateFn({ current: bps, bytes: totalBytes, elapsed: elapsed, samples: samples });
    }
    lastSample = now;
  }

  var interval = setInterval(sampleTick, 250);

  // Launch parallel downloads
  var promises = [];
  for (var i = 0; i < threads; i++) {
    promises.push((async function() {
      try {
        var resp = await fetch(fileUrl + '?t=' + Date.now() + '_' + Math.random(), { mode:'cors', cache:'no-store' });
        var reader = resp.body.getReader();
        while (true) {
          var result = await reader.read();
          if (result.done) break;
          totalBytes += result.value.length;
        }
      } catch(e) {}
    })());
  }

  await Promise.all(promises);
  clearInterval(interval);
  sampleTick(); // Final sample

  var elapsed = performance.now() - startTime;
  var avgBps = elapsed > 0 ? (totalBytes * 8 * 1000) / elapsed : 0;
  var peakBps = samples.length ? Math.max.apply(null, samples.map(function(s){ return s.bps; })) : 0;

  return { avgBps: avgBps, peakBps: peakBps, totalBytes: totalBytes, elapsed: Math.round(elapsed), samples: samples };
}

// Multi-threaded upload test
async function measureUpload(url, threads, updateFn) {
  var chunkSize = 5 * 1024 * 1024; // 5MB per thread
  var totalBytes = 0;
  var samples = [];
  var startTime = performance.now();

  function sampleTick() {
    var now = performance.now();
    var elapsed = now - startTime;
    if (elapsed > 0) {
      var bps = (totalBytes * 8 * 1000) / elapsed;
      samples.push({ t: elapsed, bps: bps });
      updateFn({ current: bps, bytes: totalBytes, elapsed: elapsed, samples: samples });
    }
  }

  var interval = setInterval(sampleTick, 250);

  var promises = [];
  for (var i = 0; i < threads; i++) {
    promises.push((async function() {
      try {
        var data = new Uint8Array(chunkSize);
        crypto.getRandomValues(new Uint8Array(data.buffer, 0, Math.min(1024, chunkSize)));
        var xhr = new XMLHttpRequest();
        var loaded = 0;
        xhr.upload.onprogress = function(e) { totalBytes += (e.loaded - loaded); loaded = e.loaded; };
        await new Promise(function(resolve, reject) {
          xhr.open('POST', url + '/speedtest-upload?t=' + Date.now() + '_' + Math.random());
          xhr.onload = resolve;
          xhr.onerror = reject;
          xhr.ontimeout = reject;
          xhr.timeout = 30000;
          xhr.send(data);
        });
      } catch(e) {}
    })());
  }

  await Promise.all(promises);
  clearInterval(interval);
  sampleTick();

  var elapsed = performance.now() - startTime;
  var avgBps = elapsed > 0 ? (totalBytes * 8 * 1000) / elapsed : 0;
  var peakBps = samples.length ? Math.max.apply(null, samples.map(function(s){ return s.bps; })) : 0;

  return { avgBps: avgBps, peakBps: peakBps, totalBytes: totalBytes, elapsed: Math.round(elapsed), samples: samples };
}

async function runTest() {
  if (running) return;
  running = true;
  var btn = document.getElementById('runBtn');
  btn.disabled = true;
  btn.textContent = 'Running...';

  var html = '';
  for (var i = 0; i < NODES.length; i++) {
    var node = NODES[i];
    var cardId = 'node-' + i;
    html += '<div class="node-card" id="' + cardId + '">';
    html += '<div class="node-header">' + node.id + ' <span class="node-region">' + (node.continent||'') + ' &middot; ' + node.url + '</span></div>';
    html += '<div class="gauge-row">';
    html += '<div class="gauge"><div class="gauge-label">Download</div><div class="gauge-val measuring" id="' + cardId + '-dl-val">--</div><div class="gauge-unit" id="' + cardId + '-dl-unit">&nbsp;</div><div class="gauge-sub" id="' + cardId + '-dl-sub">&nbsp;</div></div>';
    html += '<div class="gauge"><div class="gauge-label">Upload</div><div class="gauge-val measuring" id="' + cardId + '-ul-val">--</div><div class="gauge-unit" id="' + cardId + '-ul-unit">&nbsp;</div><div class="gauge-sub" id="' + cardId + '-ul-sub">&nbsp;</div></div>';
    html += '</div>';
    html += '<div class="live-chart" id="' + cardId + '-chart">' + Array(40).fill('<div class="live-bar" style="height:1px"></div>').join('') + '</div>';
    html += '<div class="phase" id="' + cardId + '-phase">Waiting...</div>';
    html += '<div class="progress-bar"><div class="progress-fill" id="' + cardId + '-prog"></div></div>';
    html += '<div class="stats-row" id="' + cardId + '-stats"></div>';
    html += '</div>';
  }
  document.getElementById('results').innerHTML = html;

  for (var i = 0; i < NODES.length; i++) {
    var node = NODES[i];
    var cid = 'node-' + i;
    var phase = document.getElementById(cid + '-phase');
    var prog = document.getElementById(cid + '-prog');
    var chartEl = document.getElementById(cid + '-chart');

    // Phase 1: Latency
    phase.textContent = 'Measuring latency (10 pings)...';
    prog.style.width = '5%';
    var lat = await measureLatency(node.url, 10);
    prog.style.width = '15%';

    // Phase 2: Download
    phase.textContent = 'Download test (' + THREADS + ' threads × 10 MB)...';
    var dlValEl = document.getElementById(cid + '-dl-val');
    var dlUnitEl = document.getElementById(cid + '-dl-unit');
    var dlSubEl = document.getElementById(cid + '-dl-sub');
    var chartBars = chartEl.children;
    var chartIdx = 0;

    var dl = await measureDownload(node.url, THREADS, function(d) {
      var s = fmtSpeed(d.current);
      dlValEl.textContent = s.val;
      dlUnitEl.textContent = s.unit;
      dlSubEl.textContent = fmtBytes(d.bytes) + ' transferred';
      prog.style.width = (15 + (d.bytes / (THREADS * 10485760)) * 40) + '%';
      // Update live chart bars
      if (d.samples.length > chartIdx && chartIdx < chartBars.length) {
        var maxBps = Math.max.apply(null, d.samples.map(function(x){return x.bps;})) || 1;
        var pct = Math.max((d.samples[d.samples.length-1].bps / maxBps) * 100, 2);
        chartBars[chartIdx].style.height = pct + '%';
        chartBars[chartIdx].className = 'live-bar active';
        chartIdx++;
      }
    });
    dlValEl.classList.remove('measuring');
    var dlFmt = fmtSpeed(dl.avgBps);
    dlValEl.textContent = dlFmt.val;
    dlUnitEl.textContent = dlFmt.unit;
    dlSubEl.textContent = fmtBytes(dl.totalBytes) + ' in ' + (dl.elapsed/1000).toFixed(1) + 's';

    // Reset chart for upload
    for (var b = 0; b < chartBars.length; b++) { chartBars[b].style.height = '1px'; chartBars[b].className = 'live-bar'; }
    chartIdx = 0;
    prog.style.width = '55%';

    // Phase 3: Upload
    phase.textContent = 'Upload test (' + THREADS + ' threads × 5 MB)...';
    var ulValEl = document.getElementById(cid + '-ul-val');
    var ulUnitEl = document.getElementById(cid + '-ul-unit');
    var ulSubEl = document.getElementById(cid + '-ul-sub');

    var ul = await measureUpload(node.url, THREADS, function(d) {
      var s = fmtSpeed(d.current);
      ulValEl.textContent = s.val;
      ulUnitEl.textContent = s.unit;
      ulSubEl.textContent = fmtBytes(d.bytes) + ' transferred';
      prog.style.width = (55 + (d.bytes / (THREADS * 5242880)) * 40) + '%';
      if (d.samples.length > chartIdx && chartIdx < chartBars.length) {
        var maxBps = Math.max.apply(null, d.samples.map(function(x){return x.bps;})) || 1;
        var pct = Math.max((d.samples[d.samples.length-1].bps / maxBps) * 100, 2);
        chartBars[chartIdx].style.height = pct + '%';
        chartBars[chartIdx].className = 'live-bar active';
        chartIdx++;
      }
    });
    ulValEl.classList.remove('measuring');
    var ulFmt = fmtSpeed(ul.avgBps);
    ulValEl.textContent = ulFmt.val;
    ulUnitEl.textContent = ulFmt.unit;
    ulSubEl.textContent = fmtBytes(ul.totalBytes) + ' in ' + (ul.elapsed/1000).toFixed(1) + 's';

    prog.style.width = '100%';
    phase.textContent = 'Complete';

    // Summary stats
    var dlPeak = fmtSpeed(dl.peakBps);
    var ulPeak = fmtSpeed(ul.peakBps);
    document.getElementById(cid + '-stats').innerHTML =
      '<div class="stat"><div class="stat-label">Latency (min/avg/max)</div><div class="stat-val ' + clsLatency(lat.avg) + '">' + lat.min + ' / ' + lat.avg + ' / ' + lat.max + ' ms</div></div>' +
      '<div class="stat"><div class="stat-label">Jitter</div><div class="stat-val">' + lat.jitter + ' ms</div></div>' +
      '<div class="stat"><div class="stat-label">DL Peak</div><div class="stat-val good">' + dlPeak.val + ' ' + dlPeak.unit + '</div></div>' +
      '<div class="stat"><div class="stat-label">UL Peak</div><div class="stat-val good">' + ulPeak.val + ' ' + ulPeak.unit + '</div></div>' +
      '<div class="stat"><div class="stat-label">DL Total</div><div class="stat-val">' + fmtBytes(dl.totalBytes) + '</div></div>' +
      '<div class="stat"><div class="stat-label">UL Total</div><div class="stat-val">' + fmtBytes(ul.totalBytes) + '</div></div>';
  }

  btn.disabled = false;
  btn.textContent = 'Run Speed Test';
  running = false;
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Admin Dashboard Page Shell ──

async function handleAdminDashboard(env, url) {
  // Redirect to add timezone param if missing (avoids UTC flash on first load)
  if (!url.searchParams.has('tzo')) {
    return new Response(`<script>var u=new URL(location.href);u.searchParams.set('tzo',new Date().getTimezoneOffset());location.replace(u)</script>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
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
  .chart-row { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-bottom:0.5rem; }
  .chart-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:0.75rem; }
  .chart-label { font-family:var(--mono); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); margin-bottom:0.4rem; }
  .msg-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:1rem; margin-bottom:0.75rem; }
  .msg-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; }
  .msg-title { font-weight:600; font-size:0.95rem; }
  .msg-id { font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); }
  .msg-body { font-family:var(--mono); font-size:0.82rem; white-space:pre-wrap; word-break:break-all; margin-bottom:0.5rem; padding:0.5rem; background:var(--bg); border-radius:6px; }
  .msg-meta { display:flex; justify-content:space-between; align-items:center; font-family:var(--mono); font-size:0.75rem; color:var(--text-muted); }
  .msg-fingerprint { margin-top:0.5rem; padding-top:0.5rem; border-top:1px dashed var(--border); font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); opacity:0.7; line-height:1.6; }
  .delete-msg { background:none; border:none; font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); cursor:pointer; padding:0.2rem 0.4rem; border-radius:4px; }
  .delete-msg:hover { color:var(--red); background:var(--red-light, #fef2f2); }
  .btn { padding:0.4rem 1rem; border:none; border-radius:8px; font-family:var(--mono); font-size:0.82rem; cursor:pointer; text-decoration:none; display:inline-block; }
  .btn-danger { background:var(--red, #dc2626); color:#fff; }
  .btn-danger:hover { opacity:0.85; }
  .nodes-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:0.75rem; margin-bottom:1rem; }
  .node-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:1rem; }
  .node-card.node-down { opacity:0.5; border-color:var(--red, #dc2626); }
  .node-header { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.6rem; font-family:var(--mono); font-size:0.85rem; }
  .node-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .dot-up { background:var(--green); animation:pulse 2s infinite; }
  .dot-down { background:var(--red, #dc2626); }
  .node-region { font-size:0.7rem; color:var(--text-muted); margin-left:auto; }
  .node-bw { display:grid; grid-template-columns:1fr 1fr; gap:0.35rem; margin-bottom:0.6rem; }
  .bw-row { display:flex; justify-content:space-between; background:var(--bg); padding:0.35rem 0.5rem; border-radius:6px; }
  .bw-label { font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); }
  .bw-val { font-family:var(--mono); font-size:0.78rem; font-weight:500; color:var(--accent); }
  .node-meta { display:flex; flex-wrap:wrap; gap:0.35rem 0.75rem; font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); margin-bottom:0.4rem; }
  .bw-totals { display:flex; gap:0.75rem; font-family:var(--mono); font-size:0.72rem; color:var(--text-muted); padding-top:0.4rem; border-top:1px dashed var(--border); }
  .empty { text-align:center; padding:2rem; color:var(--text-muted); font-family:var(--mono); font-size:0.85rem; }
  .ext-links { display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1.25rem; }
  .ext-links a { font-family:var(--mono); font-size:0.7rem; padding:0.25rem 0.6rem; border:1px solid var(--border); border-radius:6px; text-decoration:none; color:var(--text-muted); background:var(--surface); }
  .ext-links a:hover { border-color:var(--accent); color:var(--accent); }
  .live-dot { display:inline-block; width:7px; height:7px; background:var(--green); border-radius:50%; margin-right:0.35rem; animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @media(max-width:700px) {
    .stats-grid { grid-template-columns:repeat(2, 1fr); }
    .chart-row { grid-template-columns:1fr; }
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
    var qs = location.search || '?';
    if (qs.indexOf('tzo=') === -1) qs += (qs.length > 1 ? '&' : '') + 'tzo=' + new Date().getTimezoneOffset();
    ws = new WebSocket(proto + '//' + location.host + '/admin/ws' + qs);
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
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a> &middot; <a href="/admin/files">files</a> &middot; <a href="/admin/bandwidth">bandwidth</a> &middot; <a href="/admin/speedtest">speed test</a></p>
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

// ── Admin Files List ──

async function handleAdminFiles(env, url) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const countResult = await env.DB.prepare('SELECT COUNT(*) as total FROM files').first();
  const total = countResult?.total || 0;
  const rows = await env.DB.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
  const files = rows.results || [];
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  function buildQs(overrides) {
    const p = new URLSearchParams();
    p.set('limit', String(overrides.limit !== undefined ? overrides.limit : limit));
    if (overrides.offset) p.set('offset', String(overrides.offset));
    return '?' + p.toString();
  }

  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Files &mdash; sendf.cc admin</title><meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --green-light:#f0fdf4; --red:#dc2626; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; padding:2rem 1rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-weight:700; font-size:1.6rem; margin-bottom:0.25rem; }
  .subtitle { color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem; }
  .subtitle a { color:var(--accent); text-decoration:none; }
  .subtitle a:hover { text-decoration:underline; }
  .stats { font-family:var(--mono); font-size:0.78rem; color:var(--text-muted); margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  thead th { text-align:left; padding:0.5rem 0.75rem; font-family:var(--mono); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); border-bottom:2px solid var(--border); font-weight:500; white-space:nowrap; }
  tbody td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--border); vertical-align:top; }
  tbody tr:hover { background:var(--accent-light); }
  .td-id { font-family:var(--mono); font-size:0.78rem; }
  .td-id a { color:var(--accent); text-decoration:none; }
  .td-id a:hover { text-decoration:underline; }
  .td-name { font-family:var(--mono); font-size:0.78rem; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .td-size { font-family:var(--mono); font-size:0.78rem; text-align:right; }
  .td-date { font-family:var(--mono); font-size:0.75rem; color:var(--text-muted); white-space:nowrap; }
  .badge { display:inline-block; padding:0.1rem 0.4rem; border-radius:4px; font-family:var(--mono); font-size:0.7rem; }
  .badge-country { background:var(--green-light); color:var(--green); }
  .badge-expired { background:#fef2f2; color:var(--red); }
  .badge-active { background:var(--green-light); color:var(--green); }
  .empty { text-align:center; padding:3rem 1rem; color:var(--text-muted); font-family:var(--mono); }
  .pagination { display:flex; gap:0.5rem; margin-top:1.25rem; align-items:center; justify-content:center; }
  .pagination a, .pagination span { font-family:var(--mono); font-size:0.82rem; padding:0.35rem 0.75rem; border-radius:8px; text-decoration:none; }
  .pagination a { color:var(--accent); border:1.5px solid var(--border); }
  .pagination a:hover { border-color:var(--accent); background:var(--accent-light); }
  .pagination .current { color:var(--text); background:var(--surface); border:1.5px solid var(--border); font-weight:500; }
  @media(max-width:700px) {
    table, thead, tbody, tr, td, th { display:block; } thead { display:none; }
    tbody tr { padding:0.75rem; margin-bottom:0.75rem; background:var(--surface); border:1.5px solid var(--border); border-radius:10px; }
    tbody td { padding:0.2rem 0; border:none; }
    tbody td::before { content:attr(data-label); font-family:var(--mono); font-size:0.68rem; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:0.15rem; }
    .td-name { max-width:none; }
  }
</style></head>
<body><div class="wrap">
  <h1>Files</h1>
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a> &middot; <a href="/admin/feedback">feedback</a> &middot; <a href="/admin/bandwidth">bandwidth</a> &middot; <a href="/admin/speedtest">speed test</a></p>
  <div class="stats">${total} file${total !== 1 ? 's' : ''} &middot; page ${currentPage} of ${Math.max(totalPages, 1)}</div>
  ${files.length === 0 ? '<div class="empty">No files yet.</div>' : `
  <table><thead><tr><th>ID</th><th>Filename</th><th>Size</th><th>Node</th><th>Country</th><th>Status</th><th>Uploaded</th></tr></thead>
  <tbody>${files.map(f => {
    const expired = new Date(f.expires_at) < new Date();
    return `<tr>
      <td class="td-id" data-label="ID"><a href="/admin/file/${esc(f.id)}">${esc(f.id)}</a></td>
      <td class="td-name" data-label="File" title="${esc(f.filename)}">${esc(f.filename)}</td>
      <td class="td-size" data-label="Size">${formatBytes(f.size)}</td>
      <td data-label="Node"><span class="badge">${esc(f.node)}</span></td>
      <td data-label="Country"><span class="badge badge-country">${esc(f.country) || '&mdash;'}</span></td>
      <td data-label="Status"><span class="badge ${expired ? 'badge-expired' : 'badge-active'}">${expired ? 'expired' : 'active'}</span></td>
      <td class="td-date" data-label="Uploaded">${f.created_at || ''}</td>
    </tr>`;
  }).join('')}</tbody></table>`}
  ${totalPages > 1 ? `<div class="pagination">
    ${offset > 0 ? `<a href="/admin/files${buildQs({offset: Math.max(offset - limit, 0)})}">&larr; Prev</a>` : ''}
    <span class="current">${currentPage} / ${totalPages}</span>
    ${offset + limit < total ? `<a href="/admin/files${buildQs({offset: offset + limit})}">Next &rarr;</a>` : ''}
  </div>` : ''}
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Admin File Detail ──

async function handleAdminFileDetail(fileId, env) {
  const [file, dlStats, dlRecent, dlCountries] = await Promise.all([
    env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first(),
    env.DB.prepare('SELECT COUNT(*) as hits, COUNT(DISTINCT ip) as unique_ips FROM file_downloads WHERE file_id = ?').bind(fileId).first().catch(() => null),
    env.DB.prepare('SELECT ip, country, ua, referer, created_at FROM file_downloads WHERE file_id = ? ORDER BY created_at DESC LIMIT 50').bind(fileId).all().catch(() => null),
    env.DB.prepare('SELECT country, COUNT(*) as cnt FROM file_downloads WHERE file_id = ? AND country != \'\' GROUP BY country ORDER BY cnt DESC LIMIT 10').bind(fileId).all().catch(() => null),
  ]);
  if (!file) return new Response('File not found', { status: 404 });

  const expired = new Date(file.expires_at) < new Date();
  const configRaw = await env.NODES.get('config');
  const nodes = configRaw ? JSON.parse(configRaw) : [];
  const node = nodes.find(n => n.id === file.node);
  const fileUrl = node ? node.url + '/files/' + file.id + '/' + file.filename : '';

  const hits = dlStats?.hits || 0;
  const uniqueIps = dlStats?.unique_ips || 0;
  const estBandwidth = hits * file.size; // estimate: each page view likely = 1 download
  const downloads = dlRecent?.results || [];
  const countries = dlCountries?.results || [];

  // Fetch nginx download stats from node if available
  let nodeDownloads = null;
  if (node) {
    try {
      const r = await fetch(node.url + '/download-stats/' + fileId, { signal: AbortSignal.timeout(3000) });
      if (r.ok) nodeDownloads = await r.json();
    } catch {}
  }

  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>File ${esc(fileId)} &mdash; sendf.cc admin</title><meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=optional">
<style>
  :root { --bg:#f0fdfa; --surface:#fff; --text:#134e4a; --text-muted:#5f8a87; --accent:#0d9488; --accent-light:#ccfbf1; --border:#d1e7e5; --green:#16a34a; --green-light:#f0fdf4; --red:#dc2626; --mono:'DM Mono',monospace; --sans:'DM Sans',sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; padding:2rem 1rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-weight:700; font-size:1.6rem; margin-bottom:0.25rem; }
  h2 { font-weight:600; font-size:1.05rem; margin:1.25rem 0 0.75rem; }
  .subtitle { color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem; }
  .subtitle a { color:var(--accent); text-decoration:none; }
  .subtitle a:hover { text-decoration:underline; }
  .msg-card { background:var(--surface); border:1.5px solid var(--border); border-radius:12px; padding:1.25rem; margin-bottom:1rem; }
  .msg-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem; }
  .msg-title { font-weight:600; font-size:1rem; word-break:break-all; }
  .detail-row { display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.5rem; font-family:var(--mono); font-size:0.82rem; }
  .detail-label { color:var(--text-muted); min-width:100px; }
  .detail-value { color:var(--text); word-break:break-all; }
  .badge { display:inline-block; padding:0.1rem 0.4rem; border-radius:4px; font-family:var(--mono); font-size:0.7rem; }
  .badge-country { background:var(--green-light); color:var(--green); }
  .badge-expired { background:#fef2f2; color:var(--red); }
  .badge-active { background:var(--green-light); color:var(--green); }
  .stats-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:0.5rem; margin-bottom:1rem; }
  .stat { background:var(--surface); border:1.5px solid var(--border); border-radius:10px; padding:0.75rem; }
  .stat-label { font-family:var(--mono); font-size:0.65rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:0.2rem; }
  .stat-num { font-family:var(--mono); font-size:1.5rem; font-weight:500; color:var(--accent); }
  .stat-num.green { color:var(--green); }
  .msg-fingerprint { margin-top:0.75rem; padding-top:0.75rem; border-top:1px dashed var(--border); font-family:var(--mono); font-size:0.75rem; color:var(--text-muted); opacity:0.7; line-height:1.8; }
  .btn { padding:0.4rem 1rem; border:none; border-radius:8px; font-family:var(--mono); font-size:0.82rem; cursor:pointer; text-decoration:none; display:inline-block; }
  .btn-danger { background:var(--red); color:#fff; margin-top:1rem; }
  .btn-danger:hover { opacity:0.85; }
  .btn-link { background:none; color:var(--accent); border:1.5px solid var(--border); margin-top:1rem; margin-right:0.5rem; }
  .btn-link:hover { border-color:var(--accent); background:var(--accent-light); }
  table { width:100%; border-collapse:collapse; font-size:0.82rem; margin-bottom:1rem; }
  thead th { text-align:left; padding:0.4rem 0.6rem; font-family:var(--mono); font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); border-bottom:2px solid var(--border); font-weight:500; }
  tbody td { padding:0.4rem 0.6rem; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:0.75rem; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  tbody tr:hover { background:var(--accent-light); }
  .country-tags { display:flex; gap:0.35rem; flex-wrap:wrap; }
  @media(max-width:700px) {
    .stats-row { grid-template-columns:repeat(2, 1fr); }
    table { font-size:0.75rem; }
    thead { display:none; }
    tbody tr { display:block; padding:0.5rem; margin-bottom:0.5rem; background:var(--surface); border:1px solid var(--border); border-radius:8px; }
    tbody td { display:block; padding:0.15rem 0; border:none; max-width:none; white-space:normal; }
    tbody td::before { content:attr(data-label); font-size:0.6rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); display:block; }
  }
</style></head>
<body><div class="wrap">
  <h1>File Detail</h1>
  <p class="subtitle"><a href="/admin">&larr; Dashboard</a> &middot; <a href="/admin/files">files</a> &middot; <a href="/admin/feedback">feedback</a> &middot; <a href="/admin/bandwidth">bandwidth</a> &middot; <a href="/admin/speedtest">speed test</a></p>

  <div class="msg-card">
    <div class="msg-header">
      <div class="msg-title">${esc(file.filename)}</div>
      <span class="badge ${expired ? 'badge-expired' : 'badge-active'}">${expired ? 'expired' : 'active'}</span>
    </div>
    <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${esc(file.id)}</span></div>
    <div class="detail-row"><span class="detail-label">Size</span><span class="detail-value">${formatBytes(file.size)}</span></div>
    <div class="detail-row"><span class="detail-label">MIME</span><span class="detail-value">${esc(file.mime) || 'unknown'}</span></div>
    <div class="detail-row"><span class="detail-label">Node</span><span class="detail-value">${esc(file.node)}</span></div>
    <div class="detail-row"><span class="detail-label">URL</span><span class="detail-value"><a href="https://sendf.cc/${esc(file.id)}" style="color:var(--accent)">sendf.cc/${esc(file.id)}</a></span></div>
    <div class="detail-row"><span class="detail-label">Uploaded</span><span class="detail-value">${file.created_at || ''}</span></div>
    <div class="detail-row"><span class="detail-label">Expires</span><span class="detail-value">${file.expires_at || ''}</span></div>

    <div class="msg-fingerprint">
      IP: ${esc(file.ip) || 'unknown'}<br>
      Country: ${esc(file.country) || 'unknown'}<br>
      ${fileUrl ? 'Direct: <a href="' + esc(fileUrl) + '" style="color:var(--accent)">' + esc(fileUrl) + '</a>' : ''}
    </div>
  </div>

  <h2>Download Stats</h2>
  <div class="stats-row">
    <div class="stat"><div class="stat-label">Page Views</div><div class="stat-num">${hits}</div></div>
    <div class="stat"><div class="stat-label">Unique IPs</div><div class="stat-num green">${uniqueIps}</div></div>
    <div class="stat"><div class="stat-label">Est. Bandwidth</div><div class="stat-num">${formatBytes(estBandwidth)}</div></div>
    ${nodeDownloads ? `<div class="stat"><div class="stat-label">Node Downloads</div><div class="stat-num green">${nodeDownloads.hits || 0}</div></div>
    <div class="stat"><div class="stat-label">Node Bytes Sent</div><div class="stat-num">${formatBytes(nodeDownloads.bytes_sent || 0)}</div></div>` : ''}
  </div>

  ${countries.length > 0 ? `<div style="margin-bottom:1rem"><span style="font-family:var(--mono);font-size:0.72rem;color:var(--text-muted)">Countries: </span><span class="country-tags">${countries.map(c => '<span class="badge badge-country">' + esc(c.country) + ' ' + c.cnt + '</span>').join(' ')}</span></div>` : ''}

  ${downloads.length > 0 ? `
  <h2>Recent Downloads</h2>
  <table>
    <thead><tr><th>Time</th><th>IP</th><th>Country</th><th>Referer</th><th>User Agent</th></tr></thead>
    <tbody>
      ${downloads.map(d => `<tr>
        <td data-label="Time">${esc(d.created_at || '')}</td>
        <td data-label="IP">${esc(d.ip || '')}</td>
        <td data-label="Country">${d.country ? '<span class="badge badge-country">' + esc(d.country) + '</span>' : ''}</td>
        <td data-label="Referer" title="${esc(d.referer || '')}">${esc((d.referer || '').replace(/^https?:\/\//, '').slice(0, 40))}</td>
        <td data-label="UA" title="${esc(d.ua || '')}">${esc((d.ua || '').slice(0, 50))}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : ''}

  ${!expired && fileUrl ? '<a href="' + esc(fileUrl) + '" class="btn btn-link" target="_blank">Download from node</a>' : ''}
  <button class="btn btn-danger" onclick="deleteFile()">Delete File</button>
</div>
<script>
function deleteFile() {
  if (!confirm('Delete this file permanently?')) return;
  fetch('/admin/api/file/${file.id}', { method: 'DELETE' })
    .then(function(r) { if (r.ok) location.href = '/admin/files'; else alert('Delete failed'); })
    .catch(function() { alert('Delete failed'); });
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Admin File Delete ──

async function handleAdminDeleteFile(fileId, env) {
  const file = await env.DB.prepare('SELECT node, filename FROM files WHERE id = ?').bind(fileId).first();
  if (!file) return json({ error: 'File not found' }, 404);

  // Delete from storage node
  const configRaw = await env.NODES.get('config');
  const nodes = configRaw ? JSON.parse(configRaw) : [];
  const node = nodes.find(n => n.id === file.node);
  if (node) {
    await fetch(node.url + '/files/' + fileId + '/' + file.filename, {
      method: 'DELETE',
      headers: { 'X-Upload-Key': env.UPLOAD_KEY },
    }).catch(() => {});
  }

  // Delete from D1
  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();

  return json({ ok: true, deleted: fileId });
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
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

// ── Main Worker ──

export default {
  async scheduled(event, env, ctx) {
    // Health check all storage nodes + store bandwidth snapshots
    const configRaw = await env.NODES.get('config');
    if (configRaw) {
      const nodes = JSON.parse(configRaw);
      const ts = new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, ':00Z'); // round to minute
      for (const node of nodes) {
        const start = Date.now();
        try {
          const r = await fetch(node.url + '/stats', { signal: AbortSignal.timeout(5000) });
          if (!r.ok) throw new Error('not ok');
          const stats = await r.json();
          await env.NODES.put(node.id, JSON.stringify({
            status: 'up',
            latency: Date.now() - start,
            checked: Date.now(),
          }));
          // Store bandwidth snapshot for historical charts
          const prevRaw = await env.NODES.get('cron:' + node.id);
          const prev = prevRaw ? JSON.parse(prevRaw) : null;
          if (prev && stats.ts > prev.ts) {
            const rxDelta = Math.max(stats.rx - prev.rx, 0);
            const txDelta = Math.max(stats.tx - prev.tx, 0);
            await env.DB.prepare(
              'INSERT OR REPLACE INTO node_bandwidth (ts, node, rx_bytes, tx_bytes, disk_used, file_count) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(ts, node.id, rxDelta, txDelta, stats.disk_used || 0, stats.files || 0).run();
          }
          await env.NODES.put('cron:' + node.id, JSON.stringify({ ts: stats.ts, rx: stats.rx, tx: stats.tx }));
        } catch {
          await env.NODES.put(node.id, JSON.stringify({ status: 'down', checked: Date.now() }));
        }
      }
    }
    // Clean expired files from D1
    await env.DB.prepare('DELETE FROM files WHERE expires_at < datetime("now")').run().catch(() => {});
    // Clean expired / abandoned upload sessions (the node-side cron purges the actual chunk dirs).
    await env.DB.prepare('DELETE FROM uploads WHERE expires_at < datetime("now") OR (completed = 1 AND created_at < datetime("now", "-1 day"))').run().catch(() => {});
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

    // Upload (legacy single-shot — kept for curl / scripted callers)
    if (path === '/upload' && request.method === 'POST') {
      return handleUpload(request, env, ctx);
    }

    // Chunked resumable upload
    if (path === '/upload/init' && request.method === 'POST') {
      return handleUploadInit(request, env, ctx);
    }
    const chunkMatch = path.match(/^\/upload\/chunk\/([A-Za-z0-9]+)\/(\d+)$/);
    if (chunkMatch && request.method === 'PUT') {
      return handleUploadChunk(request, env, chunkMatch[1], parseInt(chunkMatch[2], 10));
    }
    const statusMatch = path.match(/^\/upload\/status\/([A-Za-z0-9]+)$/);
    if (statusMatch && request.method === 'GET') {
      return handleUploadStatus(request, env, statusMatch[1]);
    }
    const completeMatch = path.match(/^\/upload\/complete\/([A-Za-z0-9]+)$/);
    if (completeMatch && request.method === 'POST') {
      return handleUploadComplete(request, env, ctx, completeMatch[1]);
    }
    const abortMatch = path.match(/^\/upload\/([A-Za-z0-9]+)$/);
    if (abortMatch && request.method === 'DELETE') {
      return handleUploadAbort(request, env, abortMatch[1]);
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

    // Admin speed test page
    if (path === '/admin/speedtest') {
      return handleSpeedTestPage(env);
    }

    // Admin dashboard
    if (path === '/admin' || path === '/admin/') {
      return handleAdminDashboard(env, url);
    }

    // Admin feedback
    if (path === '/admin/feedback') {
      return handleAdminFeedback(env, url);
    }

    // Admin bandwidth history
    if (path === '/admin/bandwidth') {
      return handleAdminBandwidth(env, url);
    }

    // Admin files list
    if (path === '/admin/files') {
      return handleAdminFiles(env, url);
    }

    // Admin file detail
    const fileDetailMatch = path.match(/^\/admin\/file\/([A-Za-z0-9]{6,10})$/);
    if (fileDetailMatch) {
      return handleAdminFileDetail(fileDetailMatch[1], env);
    }

    // Admin file delete API
    const fileDeleteMatch = path.match(/^\/admin\/api\/file\/([A-Za-z0-9]{6,10})$/);
    if (fileDeleteMatch && request.method === 'DELETE') {
      return handleAdminDeleteFile(fileDeleteMatch[1], env);
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
    if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/favicon.ico' || path === '/site.webmanifest' || path === '/og-image.png' || path === '/apple-touch-icon.png' || path.match(/^\/(favicon|icon)-\d+/) || path.startsWith('/public/')) {
      const assetUrl = new URL(request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Download page — any path that looks like a file ID (6-10 alphanumeric chars)
    const idMatch = path.match(/^\/([A-Za-z0-9]{6,10})$/);
    if (idMatch) {
      return handleDownload(idMatch[1], env, request);
    }

    // 404
    return errorPage(404, 'Not Found', 'This page doesn\u2019t exist.');
  },
};
