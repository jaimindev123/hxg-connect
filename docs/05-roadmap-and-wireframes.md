# HXG Connect CRM — Development Roadmap & Wireframes

## Roadmap (team of ~6–8: 2 BE, 2 FE, 1 mobile, 1 QA, 1 PM/design)

### Phase 0 — Foundations (Weeks 1–4)
Monorepo, CI/CD, environments, auth (OIDC + JWT), multi-tenancy + RLS, RBAC framework, audit log, design system, API scaffolding + OpenAPI, seed/demo data.
**Exit:** a user can log in to an empty, permissioned, multi-tenant shell.

### Phase 1 — Lead Core (Weeks 5–10) → *Private alpha*
Contacts + leads CRUD, multiple phones, dedupe-at-capture, tags, notes, timeline, custom fields, smart filters + saved views, global search (FTS), CSV import/export, pipelines + kanban with stage rules, follow-ups + My Day queue, in-app & push notifications, basic dashboard widgets.
**Exit:** a sales team can run its full manual workflow. *No lead is ever lost* v1: unassigned-lead alarm + mandatory next-action.

### Phase 2 — Communication (Weeks 11–16) → *Beta with 2–3 design partners*
Telephony adapter layer + **Exotel** first (click-to-call, auto-log, recordings, dispositions, missed-call tracking), WhatsApp Business API inbox + templates, email (OAuth Gmail/Outlook + transactional), SMS (DLT), assignment-rule engine, escalations, call reports.
**Exit:** every customer touch is captured automatically.

### Phase 3 — Real-Estate Depth (Weeks 17–24) → *GA v1.0*
Projects/towers/units inventory with visual grid, holds/blocks, payment plans, site-visit module with GPS check-in, bookings + demand schedules + payments + Razorpay links, document generation (cost sheet, allotment letter), campaign tracking + FB/Google lead connectors + ROI reports, full report suite + exports (XLSX/CSV/PDF), calendar sync (Google/Outlook), Zoom/Meet.
**Exit:** first-enquiry → possession fully inside the CRM.

### Phase 4 — Field & Partners (Weeks 25–32)
Mobile apps GA (offline sync, voice notes, camera, card-scan OCR), CP portal + commissions + payouts, customer-support ticketing, marketing sequences (drip journeys), Tally sync, Twilio/Knowlarity/MyOperator adapters, Stripe.
**Exit:** field teams and channel partners fully onboarded.

### Phase 5 — Scale & Intelligence (Quarter 4+)
ClickHouse reporting warehouse, lead scoring (rule-based → ML), call-recording transcription + QA scoring, WhatsApp chatbot qualification, custom report builder, enterprise SSO, white-labeling, dedicated-DB tenants, regional data residency.

**Risk register (top 3):** WhatsApp/DLT template approvals (start week 1 of Phase 2 — external lead times); telephony provider webhook variance (adapter contract tests from day one); offline-sync conflicts (WatermelonDB last-write-wins + server-authoritative status fields, decided in Phase 0 ADR).

---

## Wireframes (key screens)

### 1. Dashboard
```
┌────────────────────────────────────────────────────────────────────┐
│ ☰  HXG Connect   ⌘K Search…                    🔔3   Today ▾  Priya ▾│
├──────┬─────────────────────────────────────────────────────────────┤
│ Nav  │  Good morning, Priya          [Project: All ▾] [This week ▾]│
│ ▸Dash│ ┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐      │
│ ▸Lead│ │NEW 34 ││CALLS  ││FOLLOW ││MISSED ││VISITS ││BOOKED │      │
│ ▸Pipe│ │↑12%   ││ 58    ││UPS 21 ││  4 ⚠  ││  7    ││  3 ₹2.4Cr    │
│ ▸Call│ └───────┘└───────┘└───────┘└───────┘└───────┘└───────┘      │
│ ▸Inbx│ ┌────────────────────┐ ┌──────────────────────────────┐     │
│ ▸Visit│ │ SALES FUNNEL      │ │ LEAD SOURCES (donut)         │     │
│ ▸Invt│ │ ▓▓▓▓▓▓▓▓ New 412  │ │  FB 38% · Google 24% ·       │     │
│ ▸Book│ │ ▓▓▓▓▓ Qualified   │ │  Portals 18% · CP 12% ·      │     │
│ ▸Rprt│ │ ▓▓▓ Visit  ▓ Book │ │  Walk-in 8%                  │     │
│ ▸Admn│ └────────────────────┘ └──────────────────────────────┘     │
│      │ ┌ TEAM LEADERBOARD ─────────┐ ┌ MY DAY ────────────────┐    │
│      │ │ 1 Arjun  12 visits 2 book │ │ ⚠ Overdue: Rohit M call│    │
│      │ │ 2 Priya  9 visits 1 book  │ │ 11:00 Visit—Sunrise Hts│    │
│      │ └───────────────────────────┘ └────────────────────────┘    │
└──────┴─────────────────────────────────────────────────────────────┘
```

### 2. Lead List
```
[Filters: Stage ▾  Owner ▾  Source ▾  Budget ▾  +Custom]  [Saved: Hot FB Leads ▾]
[☑ Bulk: Assign · Tag · WhatsApp · Export]                       [+ New Lead]
┌─┬──────────────┬──────────┬─────────┬──────────┬───────────┬────────────┐
│☑│ Name         │ Stage    │ Budget  │ Source   │ Next f/up │ Owner      │
│☑│ Rohit Mehra ●│ Qualified│ 80–95L  │ Facebook │ ⚠ 2h late │ Priya      │
│ │ Anita Shah   │ Visit    │ 1.2Cr   │ CP-Ravi  │ Sat 11:00 │ Arjun      │
└─┴──────────────┴──────────┴─────────┴──────────┴───────────┴────────────┘
● = stale indicator (no activity 7d)          Rows: 50 ▾   ‹ 1 2 3 … ›
```

### 3. Lead Detail (360°)
```
┌ Rohit Mehra  +91 98765·43210 ✆ ⌾WA ✉   [Stage: Qualified ▾]  [⋮ Merge]│
│ Budget 80–95L · 3BHK · Indirapuram · Src: FB/sunrise-jul · Tags: NRI  │
├────────────────────────────┬──────────────────────────────────────────┤
│ TIMELINE                   │ NEXT ACTION                              │
│ ▸ Today 10:12  ✆ Outgoing  │ ☐ Call — today 4:00 pm  [Done] [Snooze]  │
│   3m12s ▶︎ play  "wants     │ DETAILS  (custom fields…)                │
│   corner unit" — Priya     │ VISITS   Sat 11:00 Sunrise Hts (Arjun)   │
│ ▸ Yday  ⌾ WA brochure sent │ DOCS     KYC.pdf · CostSheet_v2.pdf      │
│ ▸ Mon   Stage → Qualified  │ MATCHES  T2-1204 3BHK 1450sf ₹86L ✅avail │
└────────────────────────────┴──────────────────────────────────────────┘
```

### 4. Pipeline (Kanban)
```
[Pipeline: Sunrise Heights ▾]  [Swimlane: none ▾]  [Filter…]
 NEW(34)      CONTACTED(51)   QUALIFIED(28)   VISIT(12)     NEGOTIATION(6)
┌─────────┐  ┌─────────┐     ┌─────────┐     ┌─────────┐   ┌─────────┐
│Rohit M  │  │Sanjay K │     │Anita S  │     │Vikram J │   │Meera P  │
│80-95L ⚠2d│  │60L      │     │1.2Cr 🔥 │     │Sat 11am │   │₹86L ⏳4d│
│FB · Priya│ │Portal   │     │CP·Arjun │     │Arjun    │   │Priya    │
└─────────┘  └─────────┘     └─────────┘     └─────────┘   └─────────┘
  (drag card → stage-rule modal: required note / lost reason / auto-task)
```

### 5. Inventory Grid (Tower view)
```
[Project: Sunrise Heights ▾]  [Tower T2 ▾]        🟩Avail 🟨Hold 🟥Booked ⬛Sold
F12  🟩1201  🟨1202  🟥1203  🟩1204
F11  🟩1101  🟩1102  🟥1103  ⬛1104     click unit → drawer:
F10  🟥1001  🟩1002  🟨1003  🟩1004     3BHK · 1450 sf · East · ₹86.2L
 …                                      [Hold 48h] [Book] [Share cost sheet]
```

### 6. Mobile — My Day
```
┌ 9:41 ────────────┐
│ My Day    🔔  ≡  │
│ ⚠ OVERDUE (2)    │
│ ┌──────────────┐ │
│ │Rohit M   ✆ ⌾ │ │   one-tap call / WhatsApp
│ │Call·2h late  │ │   swipe → done/snooze
│ └──────────────┘ │
│ TODAY            │
│ 11:00 SiteVisit  │
│  Sunrise Hts  📍 │ ← navigate · Check-in (GPS)
│ 16:00 Call Anita │
│ [＋]  ▷Leads ▷Pipe│
└──────────────────┘
```

Screen designs implementing this direction are in the interactive prototype (`crm-prototype.html`).
