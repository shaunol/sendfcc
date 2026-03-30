#!/bin/bash
# setup-node.sh — Provision a Debian VPS as a sendf.cc storage node
# Usage: ./setup-node.sh <upload_key> <domain>
# Example: ./setup-node.sh mysecretkey123 us-west.sendf.cc

set -e

UPLOAD_KEY="${1:?Usage: ./setup-node.sh <upload_key> <domain>}"
DOMAIN="${2:?Usage: ./setup-node.sh <upload_key> <domain>}"

echo "=== Setting up sendf.cc storage node ==="
echo "Domain: $DOMAIN"

# Install packages
apt update
apt install -y nginx-extras certbot python3-certbot-nginx ufw

# Create file storage directory
mkdir -p /files
chown -R www-data:www-data /files

# Create error pages directory and pages
mkdir -p /var/www/errors

# 403 Forbidden
cat > /var/www/errors/403.html <<'ERRORPAGE'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Access Denied &mdash; sendf.cc</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style>
</head>
<body><div class="brand">sendf<span class="cc">.cc</span></div><h1>403</h1><p>Access denied. This endpoint requires authentication.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body>
</html>
ERRORPAGE

# 404 Not Found
cat > /var/www/errors/404.html <<'ERRORPAGE'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Not Found &mdash; sendf.cc</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style>
</head>
<body><div class="brand">sendf<span class="cc">.cc</span></div><h1>404</h1><p>This file doesn&rsquo;t exist or has expired. Files are automatically deleted after 24 hours.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body>
</html>
ERRORPAGE

# 500 Internal Server Error
cat > /var/www/errors/500.html <<'ERRORPAGE'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Server Error &mdash; sendf.cc</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style>
</head>
<body><div class="brand">sendf<span class="cc">.cc</span></div><h1>500</h1><p>Something went wrong on the storage node. Please try again later.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body>
</html>
ERRORPAGE

# 502/504 Bad Gateway/Timeout
cat > /var/www/errors/502.html <<'ERRORPAGE'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Service Unavailable &mdash; sendf.cc</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional">
<style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style>
</head>
<body><div class="brand">sendf<span class="cc">.cc</span></div><h1>502</h1><p>The storage node is temporarily unavailable. Please try again in a moment.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body>
</html>
ERRORPAGE

# Configure nginx with error pages and CORS for speed test
cat > /etc/nginx/sites-available/sendf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    root /files;
    client_max_body_size 600M;

    # Custom error pages
    error_page 403 /errors/403.html;
    error_page 404 /errors/404.html;
    error_page 500 /errors/500.html;
    error_page 502 503 504 /errors/502.html;

    location /errors/ {
        alias /var/www/errors/;
        internal;
    }

    # Health check
    location = /health {
        default_type text/plain;
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
        return 200 "ok";
    }

    # Stats endpoint
    location = /stats {
        alias /var/www/stats.json;
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
    }

    # Upload via WebDAV PUT (auth required)
    location /files/ {
        dav_methods PUT DELETE;
        dav_access user:rw group:r all:r;
        create_full_put_path on;

        # Allow public GET/HEAD (for downloads + speed test CORS)
        if (\$request_method = GET) {
            break;
        }
        if (\$request_method = HEAD) {
            break;
        }
        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
            add_header Content-Length 0;
            return 204;
        }

        # Auth via shared secret header for PUT/DELETE
        if (\$http_x_upload_key != "${UPLOAD_KEY}") {
            return 403;
        }
    }

    # Block directory listings and root access
    location = / {
        return 404;
    }

    # Download (public, static files) — fallback
    location / {
        autoindex off;
        try_files \$uri =404;
    }
}
NGINX

# Enable site
ln -sf /etc/nginx/sites-available/sendf /etc/nginx/sites-enabled/sendf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# SSL via Let's Encrypt
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Cleanup cron: delete files older than 24 hours, every hour
(crontab -l 2>/dev/null; echo "0 * * * * find /files -type f -mmin +1440 -delete && find /files -type d -empty -mmin +1440 -delete") | crontab -

# Stats daemon (writes /var/www/stats.json every 2s)
cat > /usr/local/bin/sendf-stats.sh <<'STATS'
#!/bin/bash
IFACE=$(ip route show default | awk '/default/{print $5}')
while true; do
  read _ _ RX _ _ _ _ _ _ TX _ < <(grep "$IFACE" /proc/net/dev | tr -d ':')
  DISK_JSON=$(df -B1 /files | awk 'NR==2{printf "{\"total\":%s,\"used\":%s,\"free\":%s}", $2, $3, $4}')
  FILES=$(find /files -type f 2>/dev/null | wc -l)
  UPTIME=$(uptime -p 2>/dev/null | sed 's/up //' || echo "?")
  LOAD=$(cat /proc/loadavg | awk '{print $1}')
  TS=$(date +%s)
  cat > /var/www/stats.json <<EOF
{"ok":true,"ts":$TS,"iface":"$IFACE","rx":$RX,"tx":$TX,"disk_total":$(echo $DISK_JSON|python3 -c "import sys,json;print(json.load(sys.stdin)['total'])"),"disk_used":$(echo $DISK_JSON|python3 -c "import sys,json;print(json.load(sys.stdin)['used'])"),"disk_free":$(echo $DISK_JSON|python3 -c "import sys,json;print(json.load(sys.stdin)['free'])"),"files":$FILES,"uptime":"$UPTIME","load":"$LOAD"}
EOF
  sleep 2
done
STATS
chmod +x /usr/local/bin/sendf-stats.sh

cat > /etc/systemd/system/sendf-stats.service <<'SVC'
[Unit]
Description=sendf.cc stats daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/sendf-stats.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable sendf-stats
systemctl start sendf-stats

echo ""
echo "=== Setup complete ==="
echo "Node URL: https://${DOMAIN}"
echo "Health:   https://${DOMAIN}/health"
echo "Stats:    https://${DOMAIN}/stats"
echo "Upload:   PUT https://${DOMAIN}/files/{id}/{filename} (X-Upload-Key: ${UPLOAD_KEY})"
echo ""
echo "Custom error pages installed at /var/www/errors/"
echo "Add this node to your CF Worker's KV config."
