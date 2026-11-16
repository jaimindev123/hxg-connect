# HXG Connect CRM — Product Requirements Document

**Version 1.0 · July 2026**
A modern, enterprise-grade Real Estate CRM for builders, developers, channel partners, brokers, and agencies. Working name: **HXG Connect** (rename freely).

---

## 1. Vision & Goals

Real estate sales teams lose deals in the gaps: a missed callback, an unlogged site visit, a lead sitting unassigned over a weekend. HXG Connect's core promise is that **no lead is ever lost** — every enquiry is captured automatically, routed instantly, tracked through the full journey from first touch to possession, and every salesperson's actions are visible and accountable.

### Success metrics (North Stars)
| Metric | Target |
|---|---|
| Lead response time (first contact) | < 5 minutes median |
| Lead leakage (leads with no activity in 48h) | < 2% |
| Follow-up completion rate | > 90% |
| Lead → site visit conversion | Baseline +20% in 6 months |
| Daily active usage by sales users | > 85% |

### Design principles
1. **Speed over features** — every core screen loads in < 1s; every common action ≤ 2 clicks.
2. **Mobile-first for field teams** — telecallers live on desktop; sales executives live on the phone.
3. **Automation over discipline** — auto-log calls, auto-assign leads, auto-remind. Don't rely on humans remembering.
4. **India-first, global-ready** — Exotel/Knowlarity/Razorpay/Tally out of the box; Twilio/Stripe for global; multi-currency & timezone.
5. **Scale-safe** — architecture must handle millions of leads per tenant (see Tech Architecture doc).

---

## 2. Personas

| Persona | Role | Primary jobs |
|---|---|---|
| **Owner / Director** | Builder or agency owner | Revenue view, marketing ROI, team accountability |
| **Sales Manager** | Head of sales | Pipeline health, assignment rules, forecasting, coaching |
| **Team Leader** | Manages 5–15 executives | Daily follow-up review, reassignments, call audits |
| **Sales Executive** | Field sales | Follow-ups, site visits, negotiations, bookings (mobile-heavy) |
| **Telecaller** | Inside sales | High-volume dialing, qualification, dispositions (desktop-heavy) |
| **Marketing Team** | Campaign owners | Source tracking, cost-per-lead, campaign ROI |
| **CRM Executive / Admin** | Ops | Data hygiene, imports, dedupe/merge, custom fields |
| **Finance** | Accounts | Payment schedules, receipts, demand letters, Tally sync |
| **Customer Support** | Post-sales | Tickets, possession queries, document requests |
| **Channel Partner / Broker** | External | Submit leads, track status & commission (limited portal) |

---

## 3. Feature List by Module

### 3.1 Dashboard
Role-aware home screen with configurable widgets: New Leads (today/week), Today's Calls, Today's Follow-ups, Overdue Follow-ups, Missed Calls, Site Visits (scheduled/completed), Bookings, Revenue (collected vs. due), Sales Funnel, Conversion Rate by stage, Lead Sources breakdown, Marketing ROI, Team Performance leaderboard, Pending Tasks, and a Notifications feed. Widgets are drag-to-rearrange; each role gets a sensible default layout; managers can save & share custom dashboards. Date-range and project filters apply globally to the whole dashboard.

### 3.2 Lead Management
The system of record for every enquiry.

- **Lead profile**: personal details, multiple phone numbers (primary + alternates, each verifiable), email, WhatsApp number, budget range, preferred locations (multi), preferred projects (multi), property type (apartment/villa/plot/commercial/office), lead source, campaign source (UTM-level), unlimited tags, rich notes, attached documents, full timeline & activity history, lead status, assigned salesperson, linked follow-ups, meetings, site visits, and booking history.
- **Capture**: web forms, landing pages, Facebook Lead Ads, Google Ads, property portals (99acres, MagicBricks, Housing.com via webhook/email-parser), missed-call numbers, WhatsApp, QR codes, walk-ins (quick-add), CSV import, API.
- **Duplicate detection**: real-time match on phone/email at capture; fuzzy match on name+project; duplicates are flagged, never silently dropped — a re-enquiry appends to the existing lead's timeline and re-alerts the owner.
- **Lead merge**: side-by-side merge UI, field-level winner selection, activity histories concatenated, merge is logged and reversible for 30 days.
- **Auto-assignment rules**: rule engine on source, project, location, budget, language; strategies = round-robin, weighted, capacity-based, geo-based; office-hours aware with fallback queue; unassigned-lead SLA alarm.
- **Custom fields**: unlimited, typed (text, number, date, dropdown, multi-select, checkbox, file), per-entity (lead/contact/booking), reportable and filterable.
- **Smart filters & advanced search**: any field incl. custom fields, activity conditions ("no call in 7 days"), saved views shareable to teams; global search (⌘K) across leads, contacts, projects, units, documents.
- **Bulk actions**: assign, tag, stage-change, export, SMS/WhatsApp/email blast (permission-gated), delete (admin only, soft).
- **Import/Export**: CSV/XLSX import with column mapping, dedupe-on-import, dry-run preview; export respects role permissions and is audit-logged.

### 3.3 Contact & Customer Management
Contacts are people; leads are opportunities. One contact can have many leads/bookings (investor buying in 3 projects). Post-booking, the lead graduates to a **Customer** record carrying the booking, payment schedule, documents, and support tickets. 360° view: every call, message, visit, payment on one timeline.

### 3.4 Sales Pipeline (Kanban)
Drag-and-drop board. Default stages: New Lead → Contacted → Qualified → Interested → Meeting Scheduled → Site Visit → Negotiation → Booking → Payment → Registration → Possession, plus **Lost** (with mandatory lost-reason). Unlimited custom stages per pipeline; multiple pipelines (e.g., per project or per business line). Stage-change rules: required fields, mandatory note, auto-tasks on entry (e.g., entering "Site Visit" auto-creates a visit record). Cards show lead score, budget, next follow-up, owner avatar, and staleness indicator (days in stage). Board supports swimlanes by owner/source and WIP ageing alerts.

### 3.5 Follow-up & Task Management
Every lead must always have a next action — closing a follow-up without scheduling the next one (or a stage change) prompts the user. Follow-up types: call, WhatsApp, email, meeting, site visit. Snooze, reschedule with reason, escalation to team leader when overdue > X hours. "My Day" queue: a prioritized, one-tap work list (overdue → hot leads → today's schedule). General tasks (non-lead) supported with assignee, due date, checklist.

### 3.6 Calendar & Meetings
Unified calendar of follow-ups, meetings, and site visits; day/week/month views; two-way sync with Google Calendar and Outlook; Zoom/Google Meet link auto-generation; conflict detection; team calendar view for managers.

### 3.7 Call Management
- **Click-to-call** from every phone number in the UI (web via cloud telephony call-back bridging; mobile via native dialer or SIP).
- **Cloud telephony integrations**: Exotel, Knowlarity, MyOperator, Twilio, generic SIP/PBX via a provider-adapter layer (one interface, pluggable drivers).
- **Automatic call logging**: incoming/outgoing calls matched to leads by number; unknown numbers create a new lead automatically (configurable).
- **Call recording & playback**: recordings fetched from provider, stored in object storage, streamed in-app with waveform player, playback speed control, and per-role access control; retention policy configurable for compliance.
- **Disposition**: mandatory after-call disposition (connected / not reachable / wrong number / call back / interested / not interested…) with quick-note; dispositions drive automation (e.g., "call back" auto-creates a follow-up).
- **Missed call tracking**: missed-call widget, auto-callback tasks, missed-call-to-lead numbers for campaigns.
- **Reports**: calls per user/day, connect rate, talk time, average duration, first-response time, recordings audited.

### 3.8 WhatsApp / Email / SMS
- **WhatsApp Business API** (Meta Cloud API or BSPs like Gupshup/Interakt): shared team inbox, template messages with approval workflow, session messages, media, quick replies, chatbot hand-off, opt-in/opt-out tracking, all threads on the lead timeline.
- **Email**: connect Gmail/Outlook per user (OAuth) + transactional email (SES/SendGrid) for system mail; templates with merge fields; open/click tracking; BCC-to-CRM address.
- **SMS**: DLT-compliant templates (India), OTP & transactional routes, delivery reports.
- **Sequences**: multi-step drip journeys mixing WhatsApp/email/SMS with wait/branch conditions (e.g., new Facebook lead → instant WhatsApp brochure → day-2 call task → day-4 SMS).

### 3.9 Marketing Campaign Tracking
Campaign entity with budget, spend, duration, channel, and creatives. Every lead carries source + campaign + UTM parameters end-to-end. Native connectors for Facebook Lead Ads and Google Ads lead forms; webhook/UTM capture for landing pages and portals; QR-code generator that encodes campaign attribution; walk-in and referral logging. Reports: cost per lead, cost per site visit, cost per booking, ROI per campaign/channel, source-quality scoring.

### 3.10 Site Visit Management
Schedule visit (date/slot, project, assigned executive), automated confirmations to the customer (WhatsApp/SMS), executive **GPS check-in/check-out** at the site with geo-fence validation, visit notes, photos, customer feedback form (interest level, objections, liked units), auto follow-up creation, revisit tracking, and no-show handling. Visit-to-booking conversion is a first-class report.

### 3.11 Property Inventory / Project & Tower Management
Hierarchy: **Project → Tower/Phase → Floor → Unit**. Unit attributes: type, carpet/built-up/super area, facing, view, base price, PLC, floor-rise, parking, status (available / on-hold / blocked / booked / sold), and price history. Visual inventory grid (tower stack view) with live availability colors. Hold/block workflow with expiring holds. Payment plans (CLP, construction-linked, subvention, custom milestones), offers & discounts with approval limits, and a media library per project: brochures, floor plans, images, walkthrough videos, RERA documents — all shareable to a lead in one tap with tracked links.

### 3.12 Booking & Payment Tracking
Booking form linked to lead + unit (unit auto-locks), applicant/co-applicant details, agreed price with discount approval trail, chosen payment plan generating a **demand schedule** (milestones, due dates, amounts). Payment tracking: demands raised, receipts recorded (mode, reference), Razorpay/Stripe payment links, part-payments, overdue ageing, interest on delay (configurable), cancellation & refund workflow (unit auto-releases), and Tally export/sync for accounting. Documents: cost sheet, booking form, allotment letter, agreement — generated from templates.

### 3.13 Broker / Channel Partner Management
CP onboarding with KYC & RERA number, a **CP portal** (web + mobile) to submit leads and track their status, lead-attribution protection (first-submit wins, configurable validity window, conflict resolution queue), commission slabs per project, commission calculation on booking/registration, invoice upload, and payout tracking. CP leaderboards and engagement analytics.

### 3.14 Document Management
Central, permissioned document store organized by entity (lead / customer / booking / project / CP). Versioning, preview (PDF/images/office), e-sign integration hooks, expiry reminders (e.g., cheque dates, KYC), and template-based document generation with merge fields.

### 3.15 Customer Support
Post-sales ticketing: categories (payment, construction update, modification, documentation, possession), SLA timers, assignment, internal notes vs. customer replies (email/WhatsApp), CSAT survey, and knowledge-base articles. Tickets appear on the customer 360° timeline.

### 3.16 Reports & Analytics
Prebuilt reports: Lead Sources, Sales Performance (per user/team/project), Call Reports, Follow-up compliance, Site Visits & conversion, Bookings, Revenue (booked vs. collected vs. overdue), Team Performance, Marketing ROI, Lost-Lead Reasons, Customer Conversion funnel, Inventory velocity. Custom report builder (choose entity, columns, filters, group-by, chart type). Scheduled email reports (daily digest to managers). Export: Excel, CSV, PDF. All numbers drill down to the underlying leads.

### 3.17 Notifications & Reminders
In-app, push, email, and WhatsApp-to-staff channels. Triggers: new lead assigned, follow-up due/overdue, missed call, site visit today, payment due/received, stage changed, mention in a note (@user), SLA breach. Per-user notification preferences; manager escalation chains; daily "My Day" morning digest.

### 3.18 Admin Panel, Users & Roles
Org settings, branding, working hours, multi-branch/team hierarchy, user lifecycle (invite, deactivate, transfer leads on exit), role-based permissions (see §5), field-level permissions (e.g., hide phone numbers from junior roles — "masked dialing"), IP restrictions, session policies, full audit log (who saw/edited/exported what), data retention, and integration management. **Multi-tenant** by design for SaaS deployment.

### 3.19 Field Force Tracking & Attendance
Managers get real-time visibility of where field operators are; operators get a friction-free, verifiable check-in.

- **Selfie + GPS check-in (operator, mobile app):** operator taps **Check in** → front camera opens in-app (no gallery uploads allowed — camera-only prevents fake/old photos) → selfie captured with device timestamp → GPS coordinates, accuracy radius, and reverse-geocoded address are attached automatically → the packet (selfie + location + time + device id) is **auto-submitted to the assigned manager** in one tap. Same flow for check-out. Works offline: check-in is stored locally with the captured timestamp/GPS and syncs when connectivity returns, flagged "synced late".
- **Check-in types:** day start / day end (attendance), site-visit check-in/out (linked to the visit record), client-meeting check-in, and ad-hoc "mark my location".
- **Anti-spoofing:** camera-only capture, EXIF/timestamp validation, mock-location (fake GPS) detection on Android, optional liveness hint (blink prompt), geo-fence validation for site visits, and device binding (one registered device per operator).
- **Manager console (web + mobile):** live map of the team with operator pins showing latest selfie thumbnail, status (checked-in / in-visit / idle / offline), last-seen time and location accuracy; timeline view per operator (day trail of check-ins); approval queue for flagged check-ins (low GPS accuracy, mock-location suspected, late sync); one-tap "request location" ping to an operator; daily attendance summary auto-compiled from day-start/day-end check-ins.
- **Notifications:** manager is notified instantly on each check-in (configurable: all / flagged-only / digest); operator gets a reminder if day-start check-in is missing by X time.
- **Privacy & compliance by design:** tracking runs **only between day-start and day-end check-in** (never off-hours), operators see exactly what is shared and when (transparency screen), explicit consent is captured at onboarding, selfies are visible only to the management chain, and retention is configurable (default 90 days). This is required for India DPDP / GDPR defensibility.
- **Reports:** attendance register (exportable), field-hours per operator, distance travelled per day, visits per field-hour, check-in compliance %, flagged-check-in audit.

### 3.20 Mobile App (Android & iOS)
Field-first app: My Day queue, one-tap call with auto-log (native call detection where OS allows / SIM-based via telephony provider), WhatsApp deep-links, offline mode with sync (leads, notes, dispositions cached), push notifications, GPS check-in for site visits, voice notes with transcription, camera uploads (documents, site photos), lead quick-add (scan visiting card via OCR), and a lightweight kanban. Manager mode: team live view, approvals (discounts, holds).

---

## 4. Key User Flows

### 4.1 Lead capture → first contact (the 5-minute promise)
1. Lead submits Facebook form → webhook creates lead in < 5s with full campaign attribution.
2. Dedupe check → new lead → auto-assignment rule matches (project = Sunrise Heights, source = Facebook) → round-robin to Telecaller Priya.
3. Priya gets push + in-app notification; lead lands on top of her My Day queue flagged **NEW · respond < 5 min**.
4. She taps click-to-call → Exotel bridges the call → call auto-logged with recording.
5. After hang-up, a disposition sheet slides in: she picks **Interested**, sets budget ₹85L, tags "3BHK", schedules site visit Saturday 11:00.
6. System: moves stage to *Qualified*, sends WhatsApp brochure template, creates the site-visit record, notifies field executive Arjun, adds calendar entries for both.
7. If Priya hadn't acted in 10 minutes, the lead would escalate to her team leader and re-queue.

### 4.2 Site visit day
Arjun's app shows today's visits with navigation links → customer gets an auto WhatsApp reminder at T-2h → Arjun taps **Check in** at the site (GPS validated) → shows units from the live inventory grid, puts Unit T2-1204 on 48-hour hold → checks out, records voice note + interest score → system schedules a negotiation follow-up for the team leader.

### 4.3 Booking → payment
Negotiation closes at ₹82.5L (discount > slab → manager approval requested in-app → approved) → booking form pre-filled from lead → unit auto-locks → CLP demand schedule generated → cost sheet & allotment letter generated from templates → Razorpay link sent for booking amount → payment webhook marks receipt → lead graduates to Customer → finance sees it in the collections dashboard; entry queued for Tally sync.

### 4.4 Channel partner lead
CP submits a lead in the CP portal → dedupe finds the phone number already active with 30-day validity from another CP → conflict queue for the CP manager with both timestamps → resolution logged → CP notified transparently. On booking of a valid CP lead, commission is auto-computed from the project slab and appears in the CP's payout ledger.

### 4.5 Lost lead re-activation
Lead marked *Lost — budget mismatch* in March. In July, the same phone number submits a portal enquiry for a new affordable project → dedupe re-opens the existing lead, preserving history, re-assigns via rules, and tags "re-enquiry" → the full 2-project context is visible to the new owner.

---

## 5. Roles & Permission Matrix (summary)

**HXG Connect is sold as SaaS to many companies.** The full hierarchy is: **Super Admin → Platform Admins** (your staff: sales/CS, support, billing) **→ Clients** (each company = an isolated tenant with a Client Owner + Client Admins) **→ Users** (the ten CRM roles below, per client). The platform plane is specified in `06-saas-platform-layer.md`; the matrix below covers the tenant plane.

| Capability | Super Admin | Owner | Sales Mgr | Team Leader | Sales Exec | Telecaller | CRM Exec | Marketing | Finance | Support |
|---|---|---|---|---|---|---|---|---|---|---|
| See all leads | ✓ | ✓ | ✓ | Team | Own | Own | ✓ (data ops) | Read | Read | Customer-linked |
| Reassign leads | ✓ | ✓ | ✓ | Team | — | — | ✓ | — | — | — |
| Export data | ✓ | ✓ | ✓ | — | — | — | ✓ | Own reports | Financial | — |
| See phone numbers | ✓ | ✓ | ✓ | ✓ | Config | Masked (opt) | ✓ | — | — | ✓ |
| Play call recordings | ✓ | ✓ | ✓ | Team | Own | Own | — | — | — | Own |
| Edit inventory/pricing | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| Approve discounts | ✓ | ✓ | ✓ (slab) | — | — | — | — | — | — | — |
| Record payments | ✓ | — | — | — | — | — | — | — | ✓ | — |
| Manage users/roles | ✓ | ✓ | — | — | — | — | — | — | — | — |
| Campaigns & ROI | ✓ | ✓ | Read | — | — | — | — | ✓ | — | — |

Roles are **custom-definable**; the ten above ship as presets. Every permission is field-level capable and audit-logged.

---

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Scale | 10M+ leads per tenant; 5k concurrent users; 1k webhook events/sec burst |
| Performance | P95 API < 300ms; list screens < 1s; search < 500ms |
| Availability | 99.9% uptime; zero-downtime deploys |
| Security | TLS everywhere, AES-256 at rest, RBAC + field-level ACL, audit log, OWASP ASVS L2 |
| Compliance | India DPDP Act, GDPR-ready (export/erasure), DLT for SMS, call-recording consent notices, RERA data fields |
| Data | Daily backups, PITR, tenant data export |
| i18n | English + Hindi at launch; framework for more; multi-currency display |
| Offline | Mobile app functional offline for core flows; conflict-safe sync |

---

## 7. Out of Scope (v1)
Construction/project-management (Gantt), full accounting (Tally remains the ledger), payroll/HRMS, IoT site sensors, and a public listing website (integration hooks only).
