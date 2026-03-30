#!/bin/bash
# update-node-errors.sh — Deploy error pages and update nginx config on an existing node
# Usage: ./update-node-errors.sh <user@host> <upload_key> <domain>
# Example: ./update-node-errors.sh root@107.172.114.80 mysecretkey us1.sendf.cc

set -e

HOST="${1:?Usage: ./update-node-errors.sh <user@host> <upload_key> <domain>}"
UPLOAD_KEY="${2:?Usage: ./update-node-errors.sh <user@host> <upload_key> <domain>}"
DOMAIN="${3:?Usage: ./update-node-errors.sh <user@host> <upload_key> <domain>}"

echo "=== Deploying error pages to $HOST ($DOMAIN) ==="

# Create error pages and nginx config on the remote node
ssh "$HOST" bash -s "$UPLOAD_KEY" "$DOMAIN" <<'REMOTE_SCRIPT'
UPLOAD_KEY="$1"
DOMAIN="$2"

mkdir -p /var/www/errors

cat > /var/www/errors/403.html <<'EOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Access Denied — sendf.cc</title><meta name="robots" content="noindex, nofollow"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional"><style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style></head><body><div class="brand">sendf<span class="cc">.cc</span></div><h1>403</h1><p>Access denied. This endpoint requires authentication.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body></html>
EOF

cat > /var/www/errors/404.html <<'EOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found — sendf.cc</title><meta name="robots" content="noindex, nofollow"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional"><style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style></head><body><div class="brand">sendf<span class="cc">.cc</span></div><h1>404</h1><p>This file doesn&rsquo;t exist or has expired. Files are automatically deleted after 24 hours.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body></html>
EOF

cat > /var/www/errors/500.html <<'EOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Server Error — sendf.cc</title><meta name="robots" content="noindex, nofollow"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional"><style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style></head><body><div class="brand">sendf<span class="cc">.cc</span></div><h1>500</h1><p>Something went wrong on the storage node. Please try again later.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body></html>
EOF

cat > /var/www/errors/502.html <<'EOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Service Unavailable — sendf.cc</title><meta name="robots" content="noindex, nofollow"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=optional"><style>:root{--bg:#f0fdfa;--text:#134e4a;--text-muted:#5f8a87;--accent:#0d9488;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;text-align:center}.brand{font-size:1.2rem;font-weight:700;margin-bottom:2rem}.brand .cc{color:var(--accent)}h1{font-weight:700;font-size:3rem;margin-bottom:0.5rem}p{color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;max-width:400px;line-height:1.5}a{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:0.88rem}a:hover{text-decoration:underline}.links{display:flex;gap:1.5rem;justify-content:center}.node-badge{font-family:var(--mono);font-size:0.72rem;color:var(--text-muted);margin-top:2rem;padding:0.3rem 0.75rem;border:1px solid #d1e7e5;border-radius:6px}</style></head><body><div class="brand">sendf<span class="cc">.cc</span></div><h1>502</h1><p>The storage node is temporarily unavailable. Please try again in a moment.</p><div class="links"><a href="https://sendf.cc">Upload a file</a></div><div class="node-badge">storage node</div></body></html>
EOF

echo "Error pages created."

# Get existing nginx SSL config (certbot adds it)
# We need to preserve SSL directives, so we'll update the server block carefully
# First check if SSL is configured
if grep -q "ssl_certificate" /etc/nginx/sites-available/sendf 2>/dev/null; then
  echo "SSL already configured, preserving SSL directives..."
  # Extract SSL lines
  SSL_LINES=$(grep -E "ssl_certificate|listen 443|ssl;" /etc/nginx/sites-available/sendf || true)
fi

# Write updated nginx config
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

        # Allow public GET/HEAD (downloads + CORS for speed test)
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

nginx -t && systemctl reload nginx
echo "Nginx updated and reloaded."

# Re-apply SSL if it was configured
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  certbot --nginx -d "${DOMAIN}" --non-interactive --reinstall
  echo "SSL re-applied."
fi

echo "Done!"
REMOTE_SCRIPT

echo "=== Error pages deployed to $HOST ==="
echo "Test: curl -I https://$DOMAIN/"
echo "Test: curl -I https://$DOMAIN/nonexistent"
