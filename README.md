# HXG Connect — multi-tenant real estate CRM (SaaS)

This is the foundation of the product: the backend that lets you sell one CRM to many builders and agencies without any of them ever seeing each other's data. Lead management sits on top of it as the first business module.

```
Super Admin (you) ── Platform Admins (sales · support · billing)
        │  provisions, bills, supports
        ▼
Client company (tenant) ── Client Owner / Admin ── Users (10 role presets)
```

## What works today (milestone 2)

**Client CRM** (web, at `{workspace}.hxgconnect.com`)
- Sign in per workspace, invite acceptance, light and dark mode, plan-aware navigation (modules outside the plan show an upgrade prompt rather than vanishing)
- Dashboard: today's numbers, what needs attention (overdue follow-ups, open leads with no next step), pipeline funnel, lead sources
- Leads: search, stage filter, paging, add lead in ₹ lakh, duplicate enquiries routed to the existing lead
- Lead page: call and WhatsApp links, stage changes (Lost asks for the reason), notes, timeline, next step
- **Follow-ups that can't be dropped**: closing one requires scheduling the next unless the deal closed. My Day shows overdue work first.
- Pipeline board: drag cards between stages, optimistic with rollback, cards flag overdue or missing next steps
- Team: seat usage against plan, invitations, roles, reporting lines, deactivation
- **Field check-in**: front-camera selfie and live GPS in one tap, routed to the person's manager. Managers see who's out, last selfie, accuracy, a map link, and approve or reject flagged check-ins. Weak GPS, late sync and device-reported fake GPS are flagged server-side; photos are verified by file signature and served only through expiring signed links.
- Settings: approve, decline or end HXG Connect support sessions; see plan limits

**Real estate (milestone 4)**
- Inventory: projects with RERA and possession details; a tower generator that creates every unit from one floor's layout plus floor-rise pricing; a live colour-and-label grid per tower
- Holds: a unit can be held for one buyer for 1 to 168 hours; a second buyer is refused; expired holds return to sale automatically
- Units in budget: each lead's page lists available units within ±10% of their budget, with hold and book buttons
- Payment plans per project (construction-linked, 10:90…), validated to total exactly 100%
- Site visits: scheduled from the lead, shown in My Day, closed with an interest rating and a required next step; marked verified when the executive's on-site selfie check-in matches
- Bookings: the unit locks, the lead moves to won, and the schedule is generated so instalments add up to the agreed price to the paisa. Discounts above 2% need a sales manager. A database index makes double-booking impossible.
- Collections: record receipts (NEFT, UPI, cheque, cash), overpayment refused, overdue instalments flagged; one-click Razorpay payment links using the client's own keys, settled automatically by signed webhook and counted only once even if Razorpay retries
- Cancelling a booking (managers only) puts the unit straight back on sale

**Lead capture (milestone 3a)**
- One intake path for every channel: duplicate check by phone (repeat enquiries appended to the timeline), plan limit, then assignment
- Assignment rules: match on source, property type, location and budget; first matching rule wins; leads rotate through the rule's people, skipping anyone deactivated; no match falls back to least loaded
- Website forms: per-site API keys (stored hashed, shown once, revocable), copy-paste form code with UTM capture, plain-HTML forms with a thank-you redirect, a honeypot for bots, per-key rate limits. The endpoint gives the same reply for new and existing numbers so it can't be used to look up your customers.
- CSV import: Indian header names recognised (Mobile No, Customer Name, Locality…), comma or semicolon files, budgets like "80-95L" and "1.2 Cr", up to 20,000 rows, a report of skipped rows by spreadsheet row number
- Facebook and Instagram lead ads (signed webhook, answers fetched with the client's Page token) and Google Ads lead forms (webhook with a generated key), both set up from Settings > Integrations

**Communication (milestone 3b)**
- Click-to-call through the client's active provider: the agent's phone rings first, then the buyer, who sees the company number. Exotel and Twilio fully wired (call placing, recording, status callbacks; Twilio callbacks signature-checked)
- Knowlarity and MyOperator: incoming and missed calls are logged from their webhooks; click-to-call through them is not wired yet and needs building against their API docs with a test account
- Recordings play inside the CRM, streamed through the API with the provider's credentials; executives hear only their own calls; every play is audited
- Call outcomes (interested, call back, wrong number…) logged with an optional call-back task
- A missed call from an unknown number becomes a lead, assigned by the usual rules, with a "call back now" task in My Day. Provider retries don't create duplicates.
- WhatsApp: templates synced from Meta with approval status; free text only inside Meta's 24-hour window, approved templates outside it, with the right number of values checked before sending; delivery and read receipts; inbound messages threaded on the lead (or create one); STOP blocks further messages
- Inbox page across all conversations

**Reports (milestone 6a)**
- Seven reports: lead sources (visit rate, conversion, booked value), team performance, calls by day, site visits by project, bookings, collections by month, lost reasons
- Periods in India time, with presets including this financial year (April to March); up to a year per report
- On-screen tables with totals, plus Excel (formatted, frozen header) and CSV downloads; exports are audited
- Role-scoped: team leaders see their whole team (every level below them); finance sees bookings and collections; marketing sees sources and lost reasons; executives see none
- Exports neutralise spreadsheet formula injection (a lead named "=HYPERLINK(...)" opens as text), and CSVs carry a UTF-8 BOM so ₹ and Hindi names display correctly in Excel

**Channel partners (milestone 5a, Pro plan)**
- Broker firms are invited to a separate partner portal at `/partner` on the client's workspace; partner accounts can't touch any CRM endpoint, and staff accounts can't use the portal
- Partners register buyers and get a protection window (60 days by default, per partner). A buyer already with the developer, or protected by another partner, is refused with one identical message so nobody learns who holds whom. When protection lapses without a booking, another partner may register the buyer; the lead is re-attributed, never duplicated
- A booking on a protected partner lead creates the commission automatically (the partner's % of the agreed price). Managers approve, finance marks it paid with the bank reference, and the partner sees each step. Cancelling a booking voids unpaid commission
- Suspending a partner cuts off sign-in and every portal request immediately, including tokens already issued

**Subscription billing (milestone 6b)**
- Monthly invoices on the 1st for every paying client: active seats × plan price, billed in advance; re-running never issues twice
- GST tax invoices: same-state clients get CGST 9% + SGST 9%, other states IGST 18% (place of supply from the client's billing profile); numbers are consecutive within each financial year (HXG/26-27/0001) and stay gapless even if a run fails midway; no tax if you haven't entered a GSTIN
- The client owner adds GST details in Settings, views or prints invoices, and pays through a Razorpay link on your platform account; or pays by bank transfer and your billing staff mark it paid with the UTR
- Dunning: overdue moves the client to past due (banner, still working); past the grace period (15 days by default) it's suspended. A suspended workspace's owner can still sign in, but only to the billing page, to pay. Payment by webhook or manual mark-paid lifts a billing suspension automatically; suspensions made by a person are never auto-lifted
- Confirm two things with your CA before the first invoice: the SAC code (997331 is set by default, common for SaaS) and whether your invoices need e-invoicing (IRN) at your turnover

**Mobile app (milestone 5b)**: `apps/mobile`, Expo SDK 57. Sign-in with server address (works without a domain), My Day with click-to-call and required next step, lead search and history, and camera-only selfie check-ins with Android mock-GPS detection and an offline queue that keeps the original capture time. Type-checked and bundled for Android; not yet run on a device (see `apps/mobile/README.md`).

**Platform console** (web, at `admin.hxgconnect.com`, separate sign-in)
- Overview: MRR, paying clients, trials ending, past due, seats, leads managed, recent staff actions
- Clients: directory with usage, provision a workspace in one form (returns the owner's invite link), change plan, extend trial, suspend with reason, restore, request support access
- Support sessions: open a client's workspace only after they approve; read-only by default
- Plans comparison and staff management (super admin)

**Production basics in place**: one Docker image serving API and web, health check, strict CSP and security headers, per-IP and per-account sign-in rate limits, request IDs, problem+json errors, production refuses to boot with dev secrets, CI that migrates a real Postgres and runs everything.

## Integrations: keys go in the admin, not the code

No third-party account is needed to run HXG Connect. Each service switches on when its keys are entered, and they can be changed any time:

| Where | Service | What it unlocks |
|---|---|---|
| Client workspace, Settings | Exotel, Knowlarity, MyOperator or Twilio (one active) | Click-to-call and recordings (M3) |
| Client workspace, Settings | WhatsApp Business (Meta Cloud API) | Templates and inbox (M3) |
| Client workspace, Settings | Razorpay | Payment links for bookings (M4) |
| Platform console, Settings | Razorpay (billing) | Charging clients for their plan (M6) |
| Platform console, Settings | Email (SMTP: SES, Zoho, Google Workspace…) | Invitations are emailed instead of copied |
| Platform console, Settings | Domain | Workspaces at `name.hxgconnect.com`, console at `admin.hxgconnect.com` |

How it's handled:
- Secrets are sealed with AES-256-GCM (key derived from `ENCRYPTION_KEY` via HKDF) and never returned to any browser; the UI shows only the last four characters.
- Leaving a secret blank on edit keeps the stored one, so rotating one key doesn't mean retyping all of them.
- **Test connection** makes a real read-only call where the provider has one (Razorpay, Exotel, Twilio, Meta, SMTP) and reports exactly what went wrong. Knowlarity and MyOperator have no safe test call, so they're marked "saved, not verified" until first use rather than shown as connected.
- Clients' keys are client data: the platform database role can't read them, and HXG Connect support can't change them even during an approved session.
- Webhook URLs and Meta's verify token are generated per client and shown on the setup screen. Incoming Razorpay and WhatsApp events are accepted only with a valid signature and queued for the milestones that process them. Meta and Razorpay require HTTPS, so webhook setup waits for the domain and certificate; saving keys doesn't.

**Without a domain**, everything runs at the server's address (`http://your-server-ip:4000`): clients type their workspace name at sign-in, the console is at `/platform`. After buying one, follow the three steps on the console's Settings page; subdomains switch on within a minute without redeploying.

## How isolation actually works

Isolation is enforced by Postgres, not by remembering to add `WHERE tenant_id = ?`:

- **Three DB roles.** The owner role runs migrations only. `hxg_platform` (Super Admin app) can provision a workspace but has **no grant on leads at all**. `hxg_app` (client CRM) sees every tenant table through row-level security.
- **Fail-closed RLS.** Each request runs in a transaction that sets `app.tenant_id` locally. Forget to set it and queries return zero rows, not everyone's rows. The setting dies with the transaction, so a pooled connection can't carry one client's context into the next request.
- **Two auth realms.** Platform and client tokens use different secrets and audiences. A super admin token is cryptographically invalid on the CRM API; a client token is bound to its subdomain.
- **Narrow bridges.** The only places the two planes touch are a handful of `SECURITY DEFINER` functions (resolve a subdomain, read plan state, usage *counts*, approve support access) — all in `db/migrations/`, all reviewable in one sitting.

## Who sees what inside a client's workspace

Isolation between companies is above. Inside one company, a single rule in `apps/api/src/common/scope.ts` decides whose data each person sees, and every list, count, export and single-record check goes through it:

| Role | Leads, pipeline, dashboard, calls, WhatsApp, visits, bookings | Team page | Field check-ins |
|---|---|---|---|
| Owner, Admin, Sales manager | Everyone's | Everyone | Everyone's |
| Team leader | Their team: everyone who reports to them, directly or through another team leader | Their team only | Their team's |
| Sales executive, Telecaller | Their own | No | Their own |
| CRM executive, Marketing, Finance | Everyone's (per the PRD; marketing and finance are read roles) | No | Their own |
| Customer support | Booked customers only | No | Their own |

- **Handed work opens the lead.** If someone gives you a follow-up or a site visit on a lead outside your scope, you can open that lead until the job is done. It never joins your lead list.
- **Held units** show everyone that a unit is on hold and who placed the hold; only people who can see that buyer see the buyer's name.
- **Changes are live.** Role, team and status come from the database on every request, not from the sign-in token. Moving someone to another team, demoting them, or deactivating them takes effect on their next click.
- **Not found means not found.** Asking for a lead outside your scope gets the same 404 as a lead that doesn't exist, so nobody can probe for other teams' buyers.
- **Shared phones.** Check-ins taken offline are stamped with the person who took them and only ever send under that person's login. The server refuses a mismatch too.

## Run it

**Docker** (one container serves the app and the API):
```bash
cp .env.example .env      # fill in the four secrets: openssl rand -base64 48 (and back up ENCRYPTION_KEY)
docker compose up --build
# Client app:        http://localhost:4000        (workspace field on the sign-in page)
# Platform console:  http://localhost:4000/platform/login
```

**Development** (hot reload):
```bash
createdb hxg_connect
cd apps/api && npm install && npm run db:migrate && npm run build && npm start   # :4000
cd apps/web && npm install && npm run dev                                         # :5173, proxies /api
cd apps/api && npm run test:e2e                                                   # 48 tests
```

## Five-minute walkthrough

```bash
API=http://localhost:4000/api

# 1. Log in as super admin
SA=$(curl -s $API/platform/auth/login -H 'content-type: application/json' \
  -d '{"email":"founder@hxgconnect.com","password":"change-me-now-please"}' | jq -r .token)

# 2. Sell to a builder: provision their workspace on the Growth plan
INVITE=$(curl -s $API/platform/tenants -H "authorization: Bearer $SA" -H 'content-type: application/json' \
  -d '{"name":"Sunrise Realty","subdomain":"sunrise","plan_code":"growth",
       "owner":{"name":"Vikas Arora","email":"vikas@sunriserealty.in"}}' | jq -r .owner_invite_token)

# 3. Their owner accepts the invite (in production this arrives by email)
OWN=$(curl -s $API/auth/accept-invite -H 'content-type: application/json' \
  -d "{\"token\":\"$INVITE\",\"password\":\"choose-a-strong-one\"}" | jq -r .token)

# 4. They capture a lead inside their workspace
curl -s $API/leads -H "authorization: Bearer $OWN" -H 'x-tenant: sunrise' -H 'content-type: application/json' \
  -d '{"name":"Rohit Mehra","phone":"98765 43210","source":"facebook","budget_min":8000000,"budget_max":9500000}'

# 5. Back in the console: usage shows up, lead contents don't
curl -s $API/platform/tenants -H "authorization: Bearer $SA" | jq '.[] | {name, plan_code, users, leads, mrr}'
```

In production, `x-tenant` isn't needed — the API reads the workspace from the host (`sunrise.hxgconnect.com`).

## What the tests prove

`apps/api/test/saas.e2e.test.mjs` runs against a real database and tries to break things (64 tests). A small fake Razorpay and Meta server stands in for the real ones so key verification is tested without accounts:

- Client B can't list, fetch, or write to client A's leads or follow-ups; the same phone in two companies is two separate leads
- Platform tokens rejected by the CRM; client tokens rejected on another client's subdomain and on the platform API
- **At the database level**: platform role gets `permission denied` on leads; app role with no context sees 0 rows; scoped to A it can't read or insert B's rows
- Support can't get a token before approval, can't write when read-only, can't reach another client, loses access the instant the client ends it
- Suspension and expired trials lock out writes on the next request; restore and extensions undo it
- Seat limits, plan feature gates and contract overrides apply live
- Closing a follow-up without a next step is refused
- Inside one company, with two teams and a sub-team: team leaders see their whole team and nothing of the other team (leads, board, dashboard, follow-ups, calls, recordings, WhatsApp, bookings, unit holds, reports, check-ins, Team page); executives see their own; support sees booked customers only; team moves, demotions and deactivations apply on the very next request; a check-in queued by one person can't be sent under another's login
- Check-ins without a selfie, or with a non-image file renamed to .png, are rejected; weak GPS is flagged; forged photo links get 403; operators can't approve their own check-ins
- The 11th sign-in attempt for one account in 15 minutes gets 429
- Integration secrets are encrypted in the database and never returned; wrong-format keys are refused; changing one secret keeps the others; another client sees none of them; executives can't open the page
- Razorpay webhooks with a tampered amount or a forged signature are refused; Meta's verification handshake answers only with the right token
- Only one calling provider is active at a time; unverifiable providers aren't shown as connected
- Setting a domain in the console makes `client.hxgconnect.com` resolve the workspace live; removing it goes back to typed workspace names
- A held unit can't be held or booked for another buyer; expired holds are released; a booked unit can't be booked twice
- An executive's 10% discount is refused; instalments sum exactly to an odd agreed price; overpaying an instalment is refused
- A Razorpay payment link asks for exactly what's still due, and replaying its paid webhook doesn't double the receipt
- A site visit can't be closed without a next step, and is verified by a matching on-site selfie check-in
- Website capture: missing or revoked keys refused, duplicates get the identical reply, honeypot posts dropped, leads land only in the key's workspace
- Assignment rotates through the pool in order; unmatched leads fall back to least loaded
- A semicolon CSV with quoted fields imports correctly, with lakh/crore budgets parsed and bad rows reported by row number
- Facebook lead webhooks with a forged signature and Google posts with the wrong key are refused
- Click-to-call needs the agent's number, rings the agent first and records; an unsigned Twilio callback is refused; an executive can't play someone else's recording
- A missed call from a new number creates one lead and one call-back task, even when the provider retries
- WhatsApp refuses free text outside 24 hours, unapproved templates and wrong value counts; a reply opens the window; STOP blocks sending; another workspace can't read the thread
- Partner tokens are refused on the CRM and staff tokens on the portal; a direct or protected buyer can't be poached and both refusals read the same; lapsed protection re-attributes without duplicating; commission is 2% of the agreed price, must be approved before paid, and is voided by cancellation; suspension cuts off existing tokens
- Billing: a GSTIN from the wrong state is refused; invoices aren't issued twice; IGST and CGST/SGST totals are exact; one client can't open another's invoice; dunning moves past due then suspended; only the owner gets in while suspended, and only to billing; a signed payment webhook (replayed too) marks the invoice paid and lifts the suspension
- Report totals equal their rows; talk time, verified visits, receipts and lost reasons match what happened; executives are refused; a formula in a lead's data is neutralised in the CSV; the Excel file is a real .xlsx; another workspace's report contains none of A's leads

## Layout

```
apps/api/
  db/migrations/   001 platform plane · 002 tenant plane + RLS · 003 session checks
  scripts/         migrate.mjs (migrations + plan seed + first super admin)
  src/
    common/        guards (the important file), realm tokens, validation, errors, audit
    db/            two pools, withTenant() transaction helper
    platform/      super admin: auth, staff, plans, clients, provisioning, impersonation
    tenant/        client CRM: auth, users, support approvals, leads, field (gated)
  test/            end-to-end attack suite
apps/web/src/
  lib/             api client (both realms), UI kit, ₹ lakh/crore formatting
  crm/             client app: dashboard, my day, leads, pipeline, field, team, settings
  platform/        console: overview, clients, support sessions, plans, staff
docs/              PRD, schema, API, architecture, roadmap, SaaS layer, telephony, UI prototype
.github/workflows/ CI: migrate real Postgres, run tests, build web, build image
```

## Property portal leads

Settings → Integrations → **Property portals**. Two ways in, both feeding the same intake (duplicate check by phone, assignment rules by portal):

- **Forward portal emails**: works with every portal today (99acres, MagicBricks, Housing.com, NoBroker, Square Yards, CommonFloor, PropTiger, Makaan, others). Each client gets a private address; the parser reads labelled emails and HTML tables. Emails it can't read are kept under "Couldn't be read automatically", never dropped; Gmail's forwarding confirmation code is shown there too. Needs the one-time inbound email setup in the deployment guides.
- **Direct push** (how 99acres and MagicBricks connect to CRMs: their account manager configures your address): a per-portal address with **Email account manager** (pre-written request), **Send test** (a sample lead through the real pipeline, tagged `test`) and a **Recent deliveries** log with masked numbers. Accepts JSON or form posts with each portal's own field names. Replies `200 {"status":"success"}` ("Lead added" / "Existing lead updated") or `422 {"status":"failed","message":...}`, so a mapping problem shows up on the account manager's first test instead of silently.
- **Google Ads lead forms** and **Facebook/Instagram lead ads** are separate integrations in the same Lead sources group (built earlier).
- **Lead connectors** for everything else: one address per platform (`/api/webhooks/in/{source}/{key}`) for WordPress, Shopify, Wix, Webflow, Google Forms, Typeform, Jotform, Tally, IndiaMART, JustDial, Sulekha, Zapier, Make, Pabbly, n8n and any custom system. No field mapping: the reader works out name, mobile, email and message from whatever field names arrive. Shopify and Typeform signatures verified, retries ignored by delivery id, **Send test** and a delivery log per workspace. Platforms that disable a webhook after errors always get a 200; builders (WordPress, Zapier, custom) get a 422 with the reason.
- **WordPress plugin** (`integrations/wordpress/`, downloadable from the setup screen): Contact Form 7, WPForms, Elementor Pro, Gravity Forms, Ninja Forms, Fluent Forms, Formidable and WooCommerce orders, with no per-form setup.
- **Integration guide** at `/integration-guide.html`: a public page for clients and third-party developers. See `docs/08-lead-integration-guide.md`.
- Not built: portals' pull APIs (logging in to fetch leads). They are issued per account with their own documentation; add them once you have access.

## Per-client feature switches

In the console, open a client under **Clients** and use **Features for this client**. Each switch overrides the plan for that one client:

| Switch | When off |
|---|---|
| Calling and call recording | Call buttons open the phone's dialer; nothing goes through Exotel/Knowlarity/MyOperator/Twilio; no calls logged or recorded; calling settings hidden; stray provider callbacks ignored |
| Keep call recordings | Calls still go through the provider and are logged, but are placed with recording off, and no recording is stored or playable |
| WhatsApp | Thread, inbox, sending and incoming messages off; WhatsApp settings hidden |
| Field check-ins / Partner portal | Module locked with an upgrade note |

Saved integration keys are kept while a module is off. Plan defaults are now actually enforced for calling and WhatsApp (before this, a Starter client could still connect a calling provider).

## Going live

Two guides: **[DEPLOY.md](DEPLOY.md)** for a single server, and **[DEPLOY-SUPABASE-VERCEL.md](DEPLOY-SUPABASE-VERCEL.md)** for Supabase (database) + Render (API) + optional Vercel (web app). The single-server guide covers domain and DNS, server setup, production `.env`, one command to start (Caddy with automatic HTTPS, the app, PostgreSQL, nightly backups), first sign-in, console setup, off-server backups, monitoring, updates and the mobile app release. It ends with the checklist to finish before inviting paying clients.

The interface is black and white in both light and dark mode; the only colour is the gold HXG Connect logo (sidebar, sign-in, invoices, emails, app icon). Status is shown by fill, weight, borders and patterns, never by colour alone: overdue items get a solid black edge and bold text; in the unit grid, booked is solid black, on hold is hatched, blocked is dashed.

## Full-project audit (latest)

- Go-live audit fixes: production refuses to start with development database passwords, a weak or default first admin password, or missing secrets; runtime database roles take their passwords from `.env`; HTTPS certificates are issued only for your domain, `admin.` and real workspaces; the database port is never published in production; nightly backups of the database and uploaded files
- Passwords: forgot-password by email (never reveals whether an account exists), single-use one-hour reset links, admin-generated reset links when email isn't set up, change password for users and staff, all rate-limited

- 64 end-to-end tests pass from an empty database; web and mobile build; all routes served from one server with CSP
- All 27 client-data tables have row-level security enabled and forced
- Every unguarded endpoint is an intended public entry point with its own check (password, one-time token, hashed API key, provider signature, or signed link)
- Fixed in the audit: the platform database role could read client users' password hashes and phones (now limited to id, tenant, email, status); multer upload-parser denial-of-service vulnerabilities (patched via npm override)
- Remaining: 7 moderate npm advisories in the API and 2 in the web app, none high; the mobile app's high advisories are all in Expo's build tooling (CLI, Metro, code signing), not shipped in the app, and are fixed by taking Expo SDK patch releases

## Go-live check (latest)

Run in a real browser (Chromium, desktop 1366px and phone 390px) against the production build:

- Every screen of the CRM, console and partner sign-in opened as an owner: no console errors, no failed requests, no sideways scrolling, no "undefined" or broken values on screen. Repeated in production mode on a domain with `admin.` and client subdomains, from an `.env` written by `deploy/setup.sh`.
- The day-one journey clicked through the real forms: console sign-in, new client, plan price edit, feature switch, owner accepts invite, adds a lead, duplicate caught, note and follow-up, project, tower, payment plan, booking, payment, teammate invite, Excel export, sign out and back in.
- Deployment drill, from the packaged zip in a clean folder: built with the Dockerfile's own steps and production-only packages, started in production mode from a `deploy/setup.sh` `.env`, real invitation and password-reset emails sent through an SMTP server (links point at the client's `hxgconnect.com` address), then a `pg_dump` backup restored onto a fresh install with the command in DEPLOY.md: sign-in, leads, workspace isolation and encrypted integration keys all came back. Docker images themselves could not be pulled in the test environment, so the first real `docker compose up` happens on your server.
- Added after that pass: two-step sign-in for console staff (authenticator app, single-use codes, eight backup codes, reset by a super admin; clicked through in the browser and checked against the standard's published test values), a leads export for owners, admins, sales managers and CRM executives, and the privacy and terms pages.
- Fixed from that pass: console sidebar footer collapsed (name unreadable); the trial tile's label read as the wrong number; Knowlarity and MyOperator were described as click-to-call when they only log calls; invoices could be issued on the 1st with a blank seller name and a default GST state (now blocked until GST settings are saved, with a warning on the Billing screen).

## Before real clients use it

Things only you can do:

1. **A domain**, with the three DNS records in DEPLOY.md, and a server. Then `./deploy/setup.sh hxgconnect.com you@hxgconnect.com` and one `docker compose` command.
2. **Email.** Enter SMTP details in the console (Settings > Integrations). Until then, invite and reset links are shown on screen to copy.
3. **GST settings** in the console (Billing > GST settings). No invoice goes out until these are saved. Confirm the SAC code and whether you need e-invoicing with your CA.
4. **Razorpay live keys**, and one real ₹1 payment end to end.
5. **Back up `.env`**, above all `ENCRYPTION_KEY`.
6. **Legal.** A privacy policy and terms of service ship with the app (`/privacy.html`, `/terms.html`, linked from the sign-in screens; source in `apps/web/public/`). They describe what the product does today, but they were not written by a lawyer: have one read them, and check the registered address, the 30-day deletion promise and the New Delhi jurisdiction clause are what you want.
7. **Try it on your own phone and laptop** (Safari and Chrome). The automated pass used Chromium only.

Known limits, fine for a first server:

- Selfies are on the server's disk and rate limits are in memory: move to S3/R2 and Redis before adding a second server.
- Two-step sign-in covers console staff (your team). Client users sign in with a password only.
- Calling from inside the CRM works with Exotel and Twilio. Knowlarity and MyOperator log calls only.
- The mobile app builds (`cd apps/mobile && npx eas-cli build -p android --profile preview`) but has not been run on a real phone. Field check-ins work today from the phone's browser on https.
- None of the lead connectors has been run against a live account on its platform (see docs/08).

## Next milestones (building in this order)

- [x] **M4 Real estate core**: inventory, holds, payment plans, site visits, bookings, collections, Razorpay links
- [x] **M3 Lead capture**: assignment rules, CSV import with dedupe, website forms with API keys, Facebook and Google lead webhooks
- [x] **M3 Communication**: click-to-call and recordings through the active calling provider, WhatsApp templates and inbox (Knowlarity and MyOperator log calls only)
- [x] **M6 Reports**: report suite with Excel and CSV exports
- [x] **M5 Channel partners**: partner portal, lead registration with protection, commissions
- [x] **M6 Subscription billing** on the platform Razorpay account, GST invoices, dunning
- [x] **M5 Mobile app** (React Native): camera-only check-ins, mock-GPS detection, offline queue (needs on-device testing)
