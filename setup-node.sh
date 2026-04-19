#!/bin/bash
# setup-node.sh — Provision a Debian VPS as a sendf.cc storage node
# Usage: ./setup-node.sh <upload_key> <domain>
# Example: ./setup-node.sh mysecretkey123 us1.sendf.cc
#
# What this sets up:
# - nginx-extras with WebDAV for uploads, Content-Disposition for downloads
# - Let's Encrypt SSL via certbot
# - Custom themed error pages (403/404/500/502)
# - Stats daemon (sendf-stats.sh) writing /var/www/stats.json every 2s
# - Download stats CGI endpoint via fcgiwrap
# - Speed test files (10MB + 100MB) + upload sink endpoint
# - Logrotate for nginx access logs (14 days, compressed)
# - UFW firewall (22/80/443 only)
# - Hourly cleanup cron for expired files

set -e

UPLOAD_KEY="${1:?Usage: ./setup-node.sh <upload_key> <domain>}"
DOMAIN="${2:?Usage: ./setup-node.sh <upload_key> <domain>}"

echo "=== Setting up sendf.cc storage node ==="
echo "Domain: $DOMAIN"

# ── Install packages ──
apt update
apt install -y nginx-extras certbot python3-certbot-nginx ufw fcgiwrap

# ── Create directories ──
mkdir -p /files /var/www/errors
chown -R www-data:www-data /files

# ── Error pages ──
for code_msg in "403:Access denied. This endpoint requires authentication." \
                "404:This file doesn&rsquo;t exist or has expired. Files are automatically deleted after 24 hours." \
                "500:Something went wrong on the storage node. Please try again later." \
                "502:The storage node is temporarily unavailable. Please try again in a moment."; do
  code="${code_msg%%:*}"
  msg="${code_msg#*:}"
  cat > "/var/www/errors/${code}.html" <<ERRORPAGE
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>sendf.cc</title><meta name="robots" content="noindex, nofollow"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional"><style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}</style></head><body><div class="brand">sendf<span class="cc">.cc</span></div><p>${msg}</p><a href="https://sendf.cc">Upload a file</a></body></html>
ERRORPAGE
done
echo "Error pages created."

# ── Speed test files ──
dd if=/dev/urandom of=/var/www/speedtest-10mb.bin bs=1M count=10 2>/dev/null
dd if=/dev/urandom of=/var/www/speedtest-100mb.bin bs=1M count=100 2>/dev/null
echo "Speed test files created."

# ── Download stats CGI script ──
cat > /usr/local/bin/sendf-dlstats.sh <<'DLSCRIPT'
#!/bin/bash
LOG=/var/log/nginx/access.log
FID="$PATH_INFO"
[ -z "$FID" ] && FID="$QUERY_STRING"
[ -z "$FID" ] && echo "Content-Type: application/json" && echo "" && echo '{"error":"no id"}' && exit 0
echo "Content-Type: application/json"
echo ""
HITS=$(grep -c "GET /files/${FID}/" "$LOG" 2>/dev/null || echo 0)
BYTES=$(grep "GET /files/${FID}/" "$LOG" 2>/dev/null | grep " 200 \| 206 " | awk '{sum+=$10} END {print sum+0}')
echo "{\"hits\":${HITS},\"bytes_sent\":${BYTES:-0}}"
DLSCRIPT
chmod +x /usr/local/bin/sendf-dlstats.sh
echo "Download stats script installed."

# ── Stats daemon ──
cat > /usr/local/bin/sendf-stats.sh <<'STATS'
#!/bin/bash
IFACE=$(ip route show default | awk '/default/{print $5}')
while true; do
  read _ _ RX _ _ _ _ _ _ TX _ < <(grep "$IFACE" /proc/net/dev | tr -d ':')
  DISK_TOTAL=$(df -B1 /files | awk 'NR==2{print $2}')
  DISK_USED=$(df -B1 /files | awk 'NR==2{print $3}')
  DISK_FREE=$(df -B1 /files | awk 'NR==2{print $4}')
  FILES=$(find /files -type f 2>/dev/null | wc -l)
  UPTIME=$(uptime -p 2>/dev/null | sed 's/up //' || echo "?")
  LOAD=$(awk '{print $1}' /proc/loadavg)
  TS=$(date +%s)
  cat > /var/www/stats.json <<EOF
{"ok":true,"ts":$TS,"iface":"$IFACE","rx":$RX,"tx":$TX,"disk_total":$DISK_TOTAL,"disk_used":$DISK_USED,"disk_free":$DISK_FREE,"files":$FILES,"uptime":"$UPTIME","load":"$LOAD"}
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
echo "Stats daemon installed and started."

# ── fcgiwrap for download stats CGI ──
systemctl enable fcgiwrap
systemctl start fcgiwrap
echo "fcgiwrap started."

# ── Nginx config ──
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

    location = /stats {
        alias /var/www/stats.json;
        default_type application/json;
        add_header Cache-Control "no-cache";
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
    }

    # Download stats per file (CGI)
    location ~ ^/download-stats/([A-Za-z0-9]+)\$ {
        add_header Access-Control-Allow-Origin * always;
        add_header Content-Type application/json always;
        fastcgi_pass unix:/run/fcgiwrap.socket;
        fastcgi_param SCRIPT_FILENAME /usr/local/bin/sendf-dlstats.sh;
        fastcgi_param SCRIPT_NAME /sendf-dlstats.sh;
        fastcgi_param QUERY_STRING \$1;
        fastcgi_param PATH_INFO \$1;
        include fastcgi_params;
    }

    location = /health {
        default_type text/plain;
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
        return 200 "ok";
    }

    # Speed test endpoints
    location = /speedtest-10mb.bin {
        alias /var/www/speedtest-10mb.bin;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Cache-Control "no-store" always;
        if (\$request_method = OPTIONS) { return 204; }
    }
    location = /speedtest-100mb.bin {
        alias /var/www/speedtest-100mb.bin;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Cache-Control "no-store" always;
        if (\$request_method = OPTIONS) { return 204; }
    }
    location = /speedtest-upload {
        client_max_body_size 50M;
        client_body_buffer_size 1M;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;
        if (\$request_method = OPTIONS) { return 204; }
        return 200 "ok";
    }

    # File downloads — force download via Content-Disposition, auth for writes
    location ~ ^/files/[A-Za-z0-9]+/(.+)\$ {
        set \$dl_filename \$1;

        add_header Content-Disposition 'attachment; filename="\$dl_filename"' always;
        add_header X-Content-Type-Options "nosniff" always;

        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
            add_header Content-Length 0;
            return 204;
        }

        set \$auth_ok "0";
        if (\$http_x_upload_key = "${UPLOAD_KEY}") {
            set \$auth_ok "1";
        }

        set \$write_check "\${request_method}:\${auth_ok}";
        if (\$write_check ~ "^(PUT|DELETE):0\$") {
            return 403;
        }

        dav_methods PUT DELETE;
        dav_access user:rw group:r all:r;
        create_full_put_path on;

        try_files \$uri =404;
    }

    # Block root and directory listing
    location = / {
        return 404;
    }

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

# ── SSL via Let's Encrypt ──
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

# ── Chunk upload service ──
# Delegates to install-chunks.sh so the logic stays in one place and can be re-run
# on existing nodes to upgrade them.
if [ -f "$(dirname "$0")/install-chunks.sh" ]; then
  bash "$(dirname "$0")/install-chunks.sh" "$UPLOAD_KEY" "$DOMAIN"
else
  echo "WARNING: install-chunks.sh not found next to setup-node.sh — chunked uploads disabled."
  echo "         scp both files to the node and re-run, or run install-chunks.sh separately."
fi

# ── Logrotate ──
cat > /etc/logrotate.d/nginx-sendf <<'LOGROTATE'
/var/log/nginx/access.log /var/log/nginx/error.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}
LOGROTATE
echo "Logrotate configured (14 days, compressed)."

# ── Firewall ──
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ── Cleanup cron: delete files older than 24 hours, every hour ──
(crontab -l 2>/dev/null; echo "0 * * * * find /files -type f -mmin +1440 -delete && find /files -type d -empty -mmin +1440 -delete") | crontab -

echo ""
echo "=== Setup complete ==="
echo "Node URL:  https://${DOMAIN}"
echo "Health:    https://${DOMAIN}/health"
echo "Stats:     https://${DOMAIN}/stats"
echo "Upload:    PUT https://${DOMAIN}/files/{id}/{filename} (X-Upload-Key header)"
echo "Chunks:    PUT https://${DOMAIN}/chunks/{id}/{n}  |  POST https://${DOMAIN}/assemble/{id}"
echo "DL Stats:  https://${DOMAIN}/download-stats/{file_id}"
echo "Speed:     https://${DOMAIN}/speedtest-10mb.bin"
echo ""
echo "Add this node to your CF Worker KV config."
