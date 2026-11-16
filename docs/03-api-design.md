# HXG Connect CRM — API Design

**Style:** REST + JSON over HTTPS, versioned at `/api/v1`. Webhooks in and out. WebSocket channel for realtime.
**Auth:** OAuth2/OIDC. Users: short-lived JWT access token (15 min) + rotating refresh token. Server-to-server & CP portal: scoped API keys. Every token carries `tenant_id`, `role`, `scopes`.
**Conventions:** cursor pagination (`?cursor=…&limit=50`), field selection (`?fields=`), rich filtering (`?filter[stage]=qualified&filter[owner]=me&filter[last_activity][lt]=7d`), sorting (`?sort=-created_at`), idempotency keys on all POSTs (`Idempotency-Key` header), rate limits per tenant + per key (headers `X-RateLimit-*`), errors as RFC-7807 problem+json.

## Resource Map

```
/auth            login, refresh, logout, mfa
/users           /teams  /roles
/leads           core CRUD + sub-resources
/contacts        /customers
/pipelines       /stages
/follow-ups      /tasks  /meetings
/calls           telephony + recordings
/messages        whatsapp | sms | email threads
/site-visits
/projects        /towers  /units  /payment-plans
/bookings        /payment-schedules  /payments
/channel-partners /commissions /payouts
/campaigns       /sources
/documents       /templates
/tickets
/reports         /dashboards
/custom-fields   /tags
/notifications
/webhooks        /integrations
/search
```

## Key Endpoints

### Leads
```
GET    /leads                          list w/ smart filters, saved-view id support
POST   /leads                          create (runs dedupe + assignment synchronously)
GET    /leads/{id}                     360° view (expand=timeline,followups,visits)
PATCH  /leads/{id}                     partial update (stage change validates rules)
POST   /leads/{id}/assign              {owner_id | rule:"auto"}
POST   /leads/{id}/stage               {stage_id, note?, lost_reason_id?}
POST   /leads/{id}/merge               {duplicate_id, winners:{field:leadId,…}}
POST   /leads/bulk                     {ids|filter, action, params}   → 202 + job id
POST   /leads/import                   multipart CSV → 202 job {mapping, dedupe:"skip|merge|flag"}
GET    /leads/{id}/timeline            paginated activities
POST   /leads/check-duplicate          {phone?, email?} → matches[]
```

**Create lead — request/response**
```json
POST /api/v1/leads
{
  "contact": { "first_name":"Rohit", "phones":[{"phone":"+919876543210","is_primary":true}],
               "email":"rohit@x.com", "whatsapp_number":"+919876543210" },
  "budget_min": 8000000, "budget_max": 9500000,
  "property_type": "apartment",
  "preferred_locations": ["Indirapuram","Vaishali"],
  "preferred_project_ids": ["01J..."],
  "source": "facebook", "campaign_id": "01J...",
  "utm": {"utm_source":"fb","utm_campaign":"sunrise-jul"},
  "tags": ["3BHK","NRI"],
  "custom_fields": {"possession_timeline":"under_construction"}
}
→ 201
{ "id":"01K...", "stage":{"id":"…","name":"New Lead"},
  "owner":{"id":"…","name":"Priya S"}, "assignment_rule":"fb-sunrise-rr",
  "duplicate_of": null, "score": 42 }
```
If a duplicate exists: `→ 200 { "duplicate_of":"01H…", "action":"activity_appended", "reassigned":false }` (configurable).

### Calls & Telephony
```
POST   /calls/click-to-call            {lead_id, to_phone, from:"user_did"} → bridges via provider
GET    /calls?user=me&date=today
GET    /calls/{id}                     incl. recording signed URL (permission-checked)
POST   /calls/{id}/disposition         {disposition, note, follow_up:{type,due_at}?}
GET    /calls/{id}/recording           302 → time-limited signed URL
POST   /integrations/telephony/{provider}/events    ← provider webhooks (call events, recordings)
```
Provider adapters (Exotel/Knowlarity/MyOperator/Twilio/SIP) implement one interface: `originate()`, `normalizeEvent()`, `fetchRecording()`. A **self-hosted driver** (own FreeSWITCH/Kamailio switch + operator SIP trunks), a **SIM-recording mobile module** (`POST /calls/sim-log` multipart audio+metadata), and a **WebRTC in-app dialer** plug into the same interface — full design in `07-self-hosted-telephony.md`.

### Messaging
```
GET    /messages/threads?channel=whatsapp&assigned=me
POST   /messages/threads/{id}/send     {body | template_id + variables, media[]}
POST   /messages/send                  {channel, lead_id, template_id, variables}   (blast-safe, rate-limited)
POST   /integrations/whatsapp/webhook  ← Meta Cloud API inbound + status callbacks
GET    /templates?channel=whatsapp&status=approved
```

### Follow-ups & My Day
```
GET    /follow-ups/my-day              ordered queue: overdue → hot → scheduled
POST   /follow-ups                     {lead_id, type, due_at, note}
POST   /follow-ups/{id}/complete       {outcome, next:{type,due_at}?}   next required unless stage changed
POST   /follow-ups/{id}/reschedule     {due_at, reason}
```

### Inventory, Bookings, Payments
```
GET    /projects/{id}/availability     tower-grid: units + live status
POST   /units/{id}/hold                {lead_id, hours:48}  → 409 if not available (row-locked)
POST   /units/{id}/release
POST   /bookings                       {lead_id, unit_id, agreed_price, payment_plan_id, ...}
GET    /bookings/{id}/schedule
POST   /payments                       {booking_id, schedule_id, amount, mode, reference}
POST   /payments/link                  {booking_id, schedule_id, gateway:"razorpay"} → payment URL
POST   /integrations/razorpay/webhook  ← payment captured → auto-receipt
GET    /payments/export?format=tally
```

### Site Visits
```
POST   /site-visits                    schedule (auto-notifies customer + executive)
POST   /site-visits/{id}/check-in      {lat, lng}   geo-fence validated
POST   /site-visits/{id}/check-out     {lat, lng, notes, feedback, photos[]}
```

### Field Force Tracking
```
POST   /field/check-in                 multipart: selfie (camera capture) + JSON
                                       {type, lat, lng, accuracy_m, captured_at,
                                        device_id, battery_pct, site_visit_id?}
                                       → validates geo-fence & mock-location,
                                         reverse-geocodes, routes to manager,
                                         fires WS `field.checked_in` + push
POST   /field/check-out                same shape (type=day_end|site_visit_out)
GET    /field/team/live                manager: [{user, status, last_checkin:
                                        {selfie_url(signed), lat, lng, address,
                                         accuracy_m, at, flags}}]
GET    /field/users/{id}/trail?date=   day timeline: check-ins + location pings
POST   /field/users/{id}/request-location   push ping → operator one-tap respond
GET    /field/check-ins?status=flagged      review queue
POST   /field/check-ins/{id}/review    {action:"approve|reject", note}
POST   /field/pings                    batch location pings (mobile, every N min,
                                       only while day is open; server enforces)
GET    /reports/field-attendance?range=…&team=…   register + hours + compliance %
```
Offline behavior: the app queues check-ins locally with the original `captured_at` and device GPS; on sync the server compares `captured_at` vs `submitted_at` and sets `flags.late_sync` for manager review — the check-in is never lost, never silently backdated.

### Reports
```
GET  /reports/{key}?range=…&group_by=…      key: lead-sources|sales-performance|calls|
                                             follow-ups|site-visits|bookings|revenue|
                                             team|marketing-roi|lost-reasons|conversion
POST /reports/custom                         {entity, columns, filters, group_by, chart}
POST /reports/{key}/export                   {format:"xlsx|csv|pdf"} → 202 job → signed URL
GET  /dashboards/me   ·  PUT /dashboards/me  widget layout
```

### Search
```
GET /search?q=rohit+sunrise&types=leads,contacts,units,documents   → grouped, ranked
```

## Realtime (WebSocket `/ws`)
Server pushes: `lead.assigned`, `followup.due`, `call.incoming` (screen-pop with lead card), `message.received`, `visit.checked_in`, `payment.received`, `notification.*`. Clients subscribe by scope; mobile falls back to FCM/APNs push.

## Outbound Webhooks (tenant-configurable)
`lead.created|updated|stage_changed`, `booking.created`, `payment.received`, `visit.completed`, `call.completed` — HMAC-signed, retried with exponential backoff, dead-letter visible in admin.

## Background Jobs (202-pattern)
Imports, exports, bulk actions, report generation, blasts, Tally sync → `POST` returns `{job_id}`; poll `GET /jobs/{id}` or receive `job.completed` on the socket.

## Error Format
```json
{ "type":"https://docs.hxgconnect.com/errors/unit-unavailable",
  "title":"Unit unavailable", "status":409,
  "detail":"Unit T2-1204 is on hold until 2026-07-08T11:00Z",
  "trace_id":"…" }
```
