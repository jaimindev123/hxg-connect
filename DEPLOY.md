# Making HXG Connect live

One Linux server runs everything: Caddy (automatic HTTPS), the app, PostgreSQL and nightly backups. This is enough for your first clients; the README lists what to change when you outgrow one server.

## What you need first

| Item | Why | Notes |
|---|---|---|
| A domain, e.g. `hxgconnect.com` | HTTPS, client subdomains, Razorpay/Meta webhooks, Android release builds (they refuse plain `http://`) | Any registrar. You need to edit its DNS records. |
| A server: Ubuntu 24.04, 2 vCPU, 4 GB RAM, 60 GB disk | Runs the whole stack | Pick an Indian region (Mumbai or Bangalore) for speed and data residency, e.g. AWS Lightsail, DigitalOcean, Google Cloud. |
| An email sending service | Invitations and password resets | Amazon SES (Mumbai), Zoho ZeptoMail or Google Workspace SMTP. Verify your domain with them. |
| Razorpay account (live keys) | Charging clients | KYC takes a few days; start early. Test keys work for a trial run. |
| Expo account, Google Play ($25 once), Apple Developer ($99/year) | Mobile app | Only when you release the app. |

## 1. Point the domain at the server

At your DNS provider, create three **A records** pointing to the server's public IP:

| Name | Value |
|---|---|
| `@` (the domain itself) | server IP |
| `admin` | server IP |
| `*` (wildcard, for every client) | server IP |

Check from your laptop: `dig +short admin.hxgconnect.com` should print the IP. Allow up to an hour.

## 2. Prepare the server

```bash
ssh root@SERVER_IP
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh            # Docker + compose plugin
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```
Only ports 22, 80 and 443 are open. The database is never exposed.

## 3. Put the code on the server

```bash
# from your laptop
scp hxg-connect.zip root@SERVER_IP:/opt/
# on the server
cd /opt && apt install -y unzip && unzip hxg-connect.zip && cd hxg-connect
```

## 4. Create the production settings

```bash
./deploy/setup.sh hxgconnect.com you@hxgconnect.com
```
This writes `.env` with every secret and database password generated for you, and prints your first console password once. It will not overwrite an existing `.env`.

Copy the whole `.env` into your password manager now. If `ENCRYPTION_KEY` is lost, every client must re-enter their integration keys.

(To fill it in by hand instead, copy `.env.production.example` to `.env`. The app refuses to start if a secret is missing, a database password is a development default or shorter than 16 characters, or the first admin password is weak.)

## 5. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api     # wait for "HXG Connect on :4000", then Ctrl+C
```
The first start builds the app (a few minutes), runs the database migrations and creates your super admin. Open `https://admin.hxgconnect.com`: the first visit to each address takes a few seconds while its HTTPS certificate is issued.

## 6. First sign-in

1. Sign in at `https://admin.hxgconnect.com` with `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`.
2. Press **Password** in the sidebar and change it.
3. Delete the `SUPER_ADMIN_PASSWORD` line from `.env` (it's only used on the very first start).
4. Open **Settings → Two-step sign-in** and turn it on with an authenticator app (Google Authenticator, Microsoft Authenticator or Authy). Save the eight backup codes in your password manager. Ask every staff member you add to do the same; the Staff page shows who hasn't.

If you lose your phone and your backup codes, another super admin can press **Reset** next to your name on the Staff page. If you are the only one, clear it on the server and set it up again after signing in:

```bash
docker compose -f docker-compose.prod.yml exec db psql -U postgres -d hxg_connect -c "UPDATE platform.users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0, totp_backup = '[]' WHERE email = 'you@hxgconnect.com'"
```

## 7. Set up the console

1. **Settings → Integrations → Email (SMTP):** enter your sending service's details and press *Save and test*. From now on invitations and password resets are emailed.
2. **Billing → GST settings:** legal name (HXG Global LLP), GSTIN, state, address, bank details, SAC code. Confirm the SAC code and e-invoicing with your CA.
3. **Settings → Integrations → Razorpay (subscription billing):** live key ID, key secret and webhook secret. In the Razorpay dashboard add the webhook `https://hxgconnect.com/api/webhooks/platform/razorpay` with the same secret and the `payment_link.paid` event.
4. **Plan prices:** the seeded prices (₹499 / ₹999 / ₹1,499 per user per month) are placeholders. There is no edit screen yet; change them with your super admin token:
   ```bash
   TOKEN=$(curl -s https://admin.hxgconnect.com/api/platform/auth/login -H 'content-type: application/json' \
     -d '{"email":"you@hxgconnect.com","password":"YOUR_PASSWORD"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
   curl -X PUT https://admin.hxgconnect.com/api/platform/plans/growth -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"name":"Growth","price_per_user":1199,"limits":{"users":25,"leads":500000},"features":{"telephony":true,"whatsapp":true,"field_tracking":true,"cp_portal":false,"api_access":false}}'
   ```
5. **Staff:** add your support, sales and billing people. Each should change their temporary password on first sign-in.

## 8. Your first client

**Clients → New client.** The owner receives an email (or you copy the invite link), sets a password at `https://theirname.hxgconnect.com`, then in **Settings** connects their calling provider, WhatsApp and Razorpay, sets lead assignment rules, creates website form keys and invites their team.

## Receiving portal emails (one-time, optional)

Clients can forward property-portal enquiry emails into HXG Connect. To switch it on:

1. Pick a receiving subdomain, e.g. `leads.hxgconnect.com`, and an inbound email service: SendGrid Inbound Parse, Mailgun Routes or Postmark Inbound all work.
2. Add the MX record the service gives you for `leads.hxgconnect.com` (SendGrid, for example, uses `mx.sendgrid.net`, priority 10).
3. Point the service at `https://hxgconnect.com/api/webhooks/inbound-email?secret=YOUR_SECRET` (for SendGrid, leave "send raw MIME" unticked).
4. Set `INBOUND_EMAIL_DOMAIN=leads.hxgconnect.com` and `INBOUND_EMAIL_SECRET=` (from `openssl rand -hex 24`), then restart.

Each client's address then appears under Settings → Integrations → Property portals.

## 9. Backups that survive losing the server

The `backup` service writes a database dump and an archive of uploaded selfies to `/opt/hxg-connect/backups` every night and keeps 14 days. That protects against mistakes, not against losing the server, so copy them off it daily, e.g. to Amazon S3 with `rclone` or `aws s3 sync` in a cron job:

```bash
crontab -e
# 30 3 * * * aws s3 sync /opt/hxg-connect/backups s3://your-backup-bucket/hxg-connect --delete
```

**Test a restore once before launch** (on a spare server or after a fresh install):
```bash
docker compose -f docker-compose.prod.yml exec -T db pg_restore -U postgres -d hxg_connect --clean --if-exists < backups/db-YYYY-MM-DD.dump
docker compose -f docker-compose.prod.yml run --rm -v $PWD/backups:/b api sh -c "tar -xzf /b/uploads-YYYY-MM-DD.tar.gz -C /app/storage"
```

## 10. Watch it

- Add `https://hxgconnect.com/api/health` to an uptime monitor (UptimeRobot, Better Stack). It checks the app and the database.
- Logs: `docker compose -f docker-compose.prod.yml logs --tail 200 api`.
- Disk: `df -h` weekly; backups and uploads grow over time.

## 11. Updating

```bash
# take a backup first (step 9), then upload the new zip and unzip over the old folder, keeping .env
docker compose -f docker-compose.prod.yml up -d --build
```
Database migrations run automatically on start and only apply what's new.

## 12. Releasing the mobile app

```bash
cd apps/mobile
npm install -g eas-cli && eas login
eas build --platform android      # .aab for Google Play; use the "internal testing" track first
eas build --platform ios          # then TestFlight
```
Users type `https://hxgconnect.com` as the server address and their workspace name. Both stores require a **privacy policy URL** because the app uses the camera and location.

## Before you invite paying clients

- [ ] Click through every screen in Chrome, Safari and on a phone (this has never been done by a person)
- [ ] Test the mobile app on a real Android phone and iPhone: camera, GPS, airplane-mode check-in, calling
- [ ] Privacy policy and terms of service, reviewed by a lawyer (DPDP Act: selfies, location, call recordings)
- [ ] CA confirms SAC code and e-invoicing (IRN) needs
- [ ] Razorpay live keys and webhook tested with a ₹1 payment link
- [ ] A restore from backup tested (step 9)
- [ ] An independent security review
- [ ] Known limits you're accepting for now: two-step sign-in covers your console staff but not client users; Knowlarity and MyOperator log calls but can't place them from the CRM; and single-server limits (rate limits and uploaded files live on this one server; move uploads to S3 and rate limits to Redis before adding a second server)
