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
# poppler-utils provides pdftoppm, used to rasterize scanned PDFs for OCR
# (document-text.js's fallback when a PDF has no extractable text layer).
if command -v dnf >/dev/null 2>&1; then
  dnf install -y nodejs nginx poppler-utils
elif command -v apt-get >/dev/null 2>&1; then
  apt-get install -y nodejs nginx poppler-utils
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

echo "== Scheduling nightly database backup + weekly Google Sheets summary =="
# Nightly DB backup: needs no configuration - it inherits S3_BUCKET/AWS_REGION
# here at deploy time (same bucket the app already stores documents in), so
# it starts working immediately with zero post-deploy setup, unlike the
# other optional add-ons below.
# Weekly Sheets summary stays a silent no-op until GOOGLE_SHEETS_WEBHOOK_URL
# is added to backend/.env (see the instructions printed below) - the cron
# entry is installed either way so it starts working the moment that's set,
# with no need to re-run this script.
(
  crontab -l 2>/dev/null
  echo "0 2 * * * cd $APP_DIR/backend && DATA_DIR=$APP_DIR/backend/data S3_BUCKET=$S3_BUCKET AWS_REGION=ap-south-1 /usr/bin/node scripts/backup-db.js >> /var/log/mmpl-backup.log 2>&1"
  echo "0 3 * * 1 cd $APP_DIR/backend && DATA_DIR=$APP_DIR/backend/data /usr/bin/node scripts/sync-sheets.js >> /var/log/mmpl-sheets-sync.log 2>&1"
) | crontab -

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
echo ""
echo "To turn on email alerts when a client submits a new request (optional):"
echo "  cat >> $APP_DIR/backend/.env <<ENVEOF"
echo "  GMAIL_USER=youraddress@gmail.com"
echo "  GMAIL_APP_PASSWORD=your-16-char-app-password"
echo "  NOTIFY_EMAIL=where-alerts-should-go@example.com"
echo "  ENVEOF"
echo "  systemctl restart mmpl-dashboard"
echo "GMAIL_APP_PASSWORD is a Google 'App Password' (Google Account -> Security ->"
echo "2-Step Verification -> App passwords), NOT your normal Gmail password. NOTIFY_EMAIL"
echo "is optional and defaults to GMAIL_USER if omitted. Until both GMAIL_USER and"
echo "GMAIL_APP_PASSWORD are set, this is a silent no-op - nothing changes."
echo ""
echo "Nightly database backup is already running, no setup needed - every night at"
echo "2 AM the live database is snapshotted and uploaded to your S3 bucket"
echo "($S3_BUCKET) under backups/, keeping the last 14 days automatically. Check"
echo "/var/log/mmpl-backup.log on the instance to confirm it ran."
echo ""
echo "To turn on the weekly Google Sheets summary (optional):"
echo "  1. Create a new Google Sheet, then Extensions -> Apps Script, and paste in"
echo "     the contents of deploy/google-apps-script.js from the app bundle."
echo "  2. Deploy -> New deployment -> type 'Web app' -> Execute as 'Me' -> Who has"
echo "     access 'Anyone' -> Deploy, and authorize when prompted."
echo "  3. Copy the Web app URL it gives you, then run:"
echo "     echo 'GOOGLE_SHEETS_WEBHOOK_URL=your-web-app-url' >> $APP_DIR/backend/.env"
echo "  (No restart needed for this one - it only runs when the Monday cron job fires.)"
echo "Until GOOGLE_SHEETS_WEBHOOK_URL is set, this is a silent no-op - nothing changes."
