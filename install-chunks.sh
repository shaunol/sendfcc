#!/bin/bash
# install-chunks.sh — Add/refresh the chunked-upload service on an existing sendf.cc storage node.
# Usage: ./install-chunks.sh <upload_key> <domain>
# Idempotent: safe to re-run. Installs/updates:
#   - /usr/local/bin/sendf-chunks.py        (local HTTP service on 127.0.0.1:8788)
#   - /etc/systemd/system/sendf-chunks.service
#   - /var/lib/sendf-parts                  (chunk staging dir)
#   - nginx location blocks for /chunks/ and /assemble/ (auth: X-Upload-Key)
#   - cron entry to purge stale parts every 30 minutes (>12h old)

set -e

UPLOAD_KEY="${1:?Usage: ./install-chunks.sh <upload_key> <domain>}"
DOMAIN="${2:?Usage: ./install-chunks.sh <upload_key> <domain>}"

echo "=== Installing sendf chunk service on $DOMAIN ==="

# ── Python chunk service ──
cat > /usr/local/bin/sendf-chunks.py <<'PYCHUNKS'
#!/usr/bin/env python3
# sendf-chunks: local HTTP service for chunked uploads.
# Listens on 127.0.0.1:8788, auth is enforced upstream by nginx (X-Upload-Key).
#
# Endpoints:
#   PUT    /chunks/{id}/{n}   -- receive chunk n (atomic via tmp+rename)
#   GET    /chunks/{id}       -- list received chunk indexes: {"parts":[...], "bytes": N}
#   DELETE /chunks/{id}       -- abort: remove parts dir
#   POST   /assemble/{id}     -- body {"filename": "...", "totalChunks": N}
#                                assembles into /files/{id}/{filename}, removes parts

import os, re, json, shutil, glob, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FILES = '/files'
PARTS = '/var/lib/sendf-parts'
BUF = 1024 * 1024  # 1 MiB streaming buffer
ID_RE = re.compile(r'^[A-Za-z0-9]{6,32}$')
NAME_RE = re.compile(r'[^A-Za-z0-9._-]')
PART_FILE_RE = re.compile(r'^(\d+)\.part$')


def safe_uid(s):
    return s if s and ID_RE.match(s) else None


def safe_name(s):
    return (NAME_RE.sub('_', s or '')[:200]) or 'file'


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, obj=None):
        body = b'' if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_PUT(self):
        m = re.match(r'^/chunks/([A-Za-z0-9]+)/(\d+)$', self.path)
        if not m:
            return self._send(404, {'error': 'not found'})
        uid = safe_uid(m.group(1))
        if not uid:
            return self._send(400, {'error': 'bad id'})
        n = int(m.group(2))
        if n < 0 or n > 999999:
            return self._send(400, {'error': 'bad index'})

        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self._send(411, {'error': 'length required'})
        if length < 0 or length > 32 * 1024 * 1024:
            return self._send(413, {'error': 'too large'})

        d = os.path.join(PARTS, uid)
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            return self._send(500, {'error': 'mkdir failed'})

        final = os.path.join(d, '{:06d}.part'.format(n))
        tmp = final + '.tmp'
        remaining = length
        try:
            with open(tmp, 'wb') as f:
                while remaining > 0:
                    buf = self.rfile.read(min(BUF, remaining))
                    if not buf:
                        break
                    f.write(buf)
                    remaining -= len(buf)
            if remaining > 0:
                try: os.unlink(tmp)
                except Exception: pass
                return self._send(400, {'error': 'short read'})
            os.replace(tmp, final)
        except Exception as e:
            try: os.unlink(tmp)
            except Exception: pass
            sys.stderr.write('PUT error: {}\n'.format(e))
            return self._send(500, {'error': 'write failed'})

        return self._send(200, {'ok': True, 'n': n, 'size': length})

    def do_GET(self):
        m = re.match(r'^/chunks/([A-Za-z0-9]+)$', self.path)
        if not m:
            return self._send(404, {'error': 'not found'})
        uid = safe_uid(m.group(1))
        if not uid:
            return self._send(400, {'error': 'bad id'})
        d = os.path.join(PARTS, uid)
        parts = []
        total = 0
        if os.path.isdir(d):
            for entry in os.listdir(d):
                mp = PART_FILE_RE.match(entry)
                if not mp:
                    continue
                parts.append(int(mp.group(1)))
                try:
                    total += os.path.getsize(os.path.join(d, entry))
                except Exception:
                    pass
            parts.sort()
        return self._send(200, {'parts': parts, 'bytes': total})

    def do_DELETE(self):
        m = re.match(r'^/chunks/([A-Za-z0-9]+)$', self.path)
        if not m:
            return self._send(404, {'error': 'not found'})
        uid = safe_uid(m.group(1))
        if not uid:
            return self._send(400, {'error': 'bad id'})
        d = os.path.join(PARTS, uid)
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        return self._send(200, {'ok': True})

    def do_POST(self):
        m = re.match(r'^/assemble/([A-Za-z0-9]+)$', self.path)
        if not m:
            return self._send(404, {'error': 'not found'})
        uid = safe_uid(m.group(1))
        if not uid:
            return self._send(400, {'error': 'bad id'})

        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 8192:
            return self._send(400, {'error': 'bad body length'})

        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            return self._send(400, {'error': 'bad json'})
        filename = safe_name(data.get('filename') or '')
        try:
            total = int(data.get('totalChunks') or 0)
        except Exception:
            total = 0
        if total <= 0 or total > 999999:
            return self._send(400, {'error': 'bad total'})

        src = os.path.join(PARTS, uid)
        if not os.path.isdir(src):
            return self._send(404, {'error': 'no parts dir'})
        part_paths = sorted(glob.glob(os.path.join(src, '*.part')))
        if len(part_paths) != total:
            return self._send(409, {
                'error': 'parts missing',
                'have': len(part_paths),
                'want': total,
            })

        dst_dir = os.path.join(FILES, uid)
        try:
            os.makedirs(dst_dir, exist_ok=True)
        except Exception:
            return self._send(500, {'error': 'mkdir failed'})
        dst = os.path.join(dst_dir, filename)
        tmp = dst + '.tmp'
        try:
            with open(tmp, 'wb') as out:
                for p in part_paths:
                    with open(p, 'rb') as pf:
                        shutil.copyfileobj(pf, out, BUF)
            os.replace(tmp, dst)
            size = os.path.getsize(dst)
        except Exception as e:
            try: os.unlink(tmp)
            except Exception: pass
            sys.stderr.write('assemble error: {}\n'.format(e))
            return self._send(500, {'error': 'assemble failed'})

        shutil.rmtree(src, ignore_errors=True)
        return self._send(200, {'ok': True, 'size': size, 'filename': filename})

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    os.makedirs(PARTS, exist_ok=True)
    try:
        os.chmod(PARTS, 0o755)
    except Exception:
        pass
    srv = ThreadingHTTPServer(('127.0.0.1', 8788), H)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
PYCHUNKS
chmod +x /usr/local/bin/sendf-chunks.py

# ── Parts directory ──
mkdir -p /var/lib/sendf-parts
chown -R www-data:www-data /var/lib/sendf-parts
chmod 755 /var/lib/sendf-parts

# ── systemd unit ──
cat > /etc/systemd/system/sendf-chunks.service <<'UNIT'
[Unit]
Description=sendf.cc chunk upload service
After=network.target

[Service]
ExecStart=/usr/local/bin/sendf-chunks.py
User=www-data
Group=www-data
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/files /var/lib/sendf-parts
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable sendf-chunks
systemctl restart sendf-chunks
echo "Chunk service installed and running on 127.0.0.1:8788."

# ── Nginx location blocks ──
# We inject /chunks/ and /assemble/ locations before the final catch-all.
# Safe re-run: we regenerate the chunk-snippet and rely on setup-node.sh's main config.
CHUNK_SNIPPET=/etc/nginx/snippets/sendf-chunks.conf
cat > "$CHUNK_SNIPPET" <<NGINX
# sendf.cc chunk upload endpoints — auth via X-Upload-Key, proxy to local service.
location ~ ^/chunks/[A-Za-z0-9]+(/[0-9]+)?\$ {
    if (\$http_x_upload_key != "${UPLOAD_KEY}") { return 403; }
    client_max_body_size 32M;
    client_body_buffer_size 1M;
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_set_header Host \$host;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    add_header Cache-Control "no-store" always;
}

location ~ ^/assemble/[A-Za-z0-9]+\$ {
    if (\$http_x_upload_key != "${UPLOAD_KEY}") { return 403; }
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    # Assembly can take a while for large files — allow up to 10 minutes.
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    add_header Cache-Control "no-store" always;
}
NGINX

# Ensure the main nginx site includes the snippet.
SITE=/etc/nginx/sites-available/sendf
if [ -f "$SITE" ] && ! grep -q "sendf-chunks.conf" "$SITE"; then
  # Insert include just before the "location / {" catch-all line.
  awk '
    /^    location \/ \{/ && !done { print "    include snippets/sendf-chunks.conf;"; print ""; done=1 }
    { print }
  ' "$SITE" > "$SITE.new" && mv "$SITE.new" "$SITE"
  echo "Patched $SITE to include chunk snippet."
fi

nginx -t && systemctl reload nginx

# ── Parts-directory cleanup cron (stale >12h) ──
CRON_LINE='*/30 * * * * find /var/lib/sendf-parts -mindepth 1 -maxdepth 1 -type d -mmin +720 -exec rm -rf {} + 2>/dev/null'
( crontab -l 2>/dev/null | grep -v 'sendf-parts' ; echo "$CRON_LINE" ) | crontab -

echo ""
echo "=== Chunk service ready ==="
echo "Test: curl -s -H 'X-Upload-Key: \${UPLOAD_KEY}' https://$DOMAIN/chunks/AAAAAAAA"
echo 'Expected: {"parts": [], "bytes": 0}'
