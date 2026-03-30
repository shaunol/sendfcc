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

# Configure nginx
cat > /etc/nginx/sites-available/sendf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    root /files;
    client_max_body_size 600M;

    # Health check
    location = /health {
        default_type text/plain;
        return 200 "ok";
    }

    # Upload via WebDAV PUT (auth required)
    location /files/ {
        dav_methods PUT DELETE;
        dav_access user:rw group:r all:r;
        create_full_put_path on;

        # Auth via shared secret header
        if (\$http_x_upload_key != "${UPLOAD_KEY}") {
            return 403;
        }

        # Only allow PUT and DELETE with auth
        limit_except GET HEAD {
            # Already handled by the if block above
        }
    }

    # Download (public, static files)
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

echo ""
echo "=== Setup complete ==="
echo "Node URL: https://${DOMAIN}"
echo "Health:   https://${DOMAIN}/health"
echo "Upload:   PUT https://${DOMAIN}/files/{id}/{filename} (X-Upload-Key: ${UPLOAD_KEY})"
echo ""
echo "Add this node to your CF Worker's KV config."
