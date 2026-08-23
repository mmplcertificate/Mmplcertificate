#!/bin/bash
# Runs ON the EC2 instance itself (delivered via user-data / SSM RunCommand
# by cloudshell-setup.sh). Installs Node, unpacks the app bundle already
# copied to /opt/mmpl-app.tar.gz, wires up systemd + nginx + Let's Encrypt.
set -euo pipefail

APP_DIR=/opt/mmpl-app
BUNDLE=/opt/mmpl-app.tar.gz
DOMAIN="$1"   # e.g. 13-235-1-1.nip.io
S3_BUCKET="$2"

echo "== Installing Node.js 20 =="
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - || \
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
if command -v dnf >/dev/null 2>&1; then
  dnf install -y nodejs nginx
elif command -v apt-get >/dev/null 2>&1; then
  apt-get install -y nodejs nginx
fi

echo "== Unpacking application =="
mkdir -p "$APP_DIR"
tar -xzf "$BUNDLE" -C "$APP_DIR"

echo "== Installing backend dependencies =="
cd "$APP_DIR/backend"
npm install --omit=dev --no-audit --no-fund

echo "== Running database migrations =="
DATA_DIR="$APP_DIR/backend/data" node scripts/run-migrations.js

echo "== Creating default admin account (username: admin) =="
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)
DATA_DIR="$APP_DIR/backend/data" node scripts/create-user.js admin "$ADMIN_PASSWORD" admin
echo "$ADMIN_PASSWORD" > /root/mmpl-admin-password.txt
chmod 600 /root/mmpl-admin-password.txt

echo "== Writing systemd service =="
cat > /etc/systemd/system/mmpl-dashboard.service <<EOF
[Unit]
Description=MMPL Certificates Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/backend
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=$APP_DIR/backend/data
Environment=S3_BUCKET=$S3_BUCKET
Environment=AWS_REGION=ap-south-1
Environment=JWT_SECRET=$(openssl rand -hex 32)
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mmpl-dashboard
systemctl restart mmpl-dashboard

echo "== Configuring nginx reverse proxy =="
cat > /etc/nginx/conf.d/mmpl-dashboard.conf <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 250M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true
systemctl enable nginx
systemctl restart nginx

echo "== Requesting Let's Encrypt certificate for $DOMAIN =="
if command -v dnf >/dev/null 2>&1; then
  dnf install -y certbot python3-certbot-nginx
else
  apt-get install -y certbot python3-certbot-nginx
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" --redirect || \
  echo "certbot failed - site is still reachable over plain HTTP at http://$DOMAIN, retry certbot manually once DNS/nip.io resolution is confirmed."

echo "== Done =="
echo "URL: https://$DOMAIN"
echo "Admin username: admin"
echo "Admin password: $(cat /root/mmpl-admin-password.txt)"
echo ""
echo "To turn on fully-automated client drafting (Gemini API, optional):"
echo "  echo 'GEMINI_API_KEY=your-key-here' >> $APP_DIR/backend/.env"
echo "  systemctl restart mmpl-dashboard"
echo "Until GEMINI_API_KEY is set, client requests queue for manual review/delivery as before -"
echo "nothing about drafting changes until you explicitly add the key."
