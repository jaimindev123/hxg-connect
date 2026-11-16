# HXG Connect CRM — Database Schema

**PostgreSQL 16 · multi-tenant (shared schema, `tenant_id` on every row + Row-Level Security)**

Conventions: UUIDv7 primary keys (time-sortable), `created_at/updated_at/deleted_at` on all tables (soft delete), `custom_fields JSONB` on extensible entities, all FKs indexed, composite indexes lead with `tenant_id`.

## Entity-Relationship Overview

```
Tenant ─┬─ Users ── Teams (hierarchy)
        ├─ Contacts ──< Leads >── Pipelines/Stages
        │                │
        │                ├──< Activities (calls, notes, messages, emails, visits, tasks)
        │                ├──< FollowUps
        │                ├──< LeadSources / Campaigns (attribution)
        │                └──< Bookings ──< PaymentSchedule ──< Payments
        ├─ Projects ──< Towers ──< Floors ──< Units >── PricingRules / PaymentPlans
        ├─ ChannelPartners ──< CPLeads / Commissions / Payouts
        ├─ Documents (polymorphic)
        ├─ Tickets (support)
        └─ AuditLog / Notifications / Webhooks / IntegrationConfigs
```

## Core DDL (abridged to essential columns)

```sql
-- ============ TENANCY, USERS, TEAMS ============
CREATE TABLE tenants (
  id uuid PRIMARY KEY, name text NOT NULL, plan text, settings jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants,
  email citext UNIQUE NOT NULL, phone text, name text NOT NULL,
  role_id uuid REFERENCES roles, team_id uuid REFERENCES teams,
  status text DEFAULT 'active',            -- active|inactive|invited
  working_hours jsonb, notification_prefs jsonb,
  last_seen_at timestamptz, created_at timestamptz DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY, tenant_id uuid, name text,
  parent_team_id uuid REFERENCES teams,    -- hierarchy: branch > team
  leader_id uuid REFERENCES users
);

CREATE TABLE roles (
  id uuid PRIMARY KEY, tenant_id uuid, name text, is_system boolean,
  permissions jsonb NOT NULL               -- {"leads.view":"team","calls.play":"own",...}
);

-- ============ CONTACTS & LEADS ============
CREATE TABLE contacts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  first_name text, last_name text, email citext,
  whatsapp_number text, dob date, address jsonb,
  custom_fields jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(), updated_at timestamptz, deleted_at timestamptz
);

CREATE TABLE contact_phones (                -- multiple phone numbers
  id uuid PRIMARY KEY, tenant_id uuid, contact_id uuid REFERENCES contacts,
  phone text NOT NULL, label text, is_primary boolean DEFAULT false, verified boolean
);
CREATE UNIQUE INDEX ux_phone_tenant ON contact_phones(tenant_id, phone); -- dedupe backbone

CREATE TABLE pipelines (
  id uuid PRIMARY KEY, tenant_id uuid, name text, is_default boolean
);
CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY, tenant_id uuid, pipeline_id uuid REFERENCES pipelines,
  name text, position int, probability int, is_won boolean, is_lost boolean,
  rules jsonb                                -- required fields, auto-tasks on entry
);

CREATE TABLE leads (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  contact_id uuid REFERENCES contacts,
  pipeline_id uuid, stage_id uuid REFERENCES pipeline_stages,
  status text DEFAULT 'open',               -- open|won|lost|junk
  lost_reason_id uuid REFERENCES lost_reasons,
  owner_id uuid REFERENCES users, team_id uuid,
  budget_min numeric, budget_max numeric,
  property_type text,                       -- apartment|villa|plot|commercial
  preferred_locations text[], preferred_project_ids uuid[],
  source_id uuid REFERENCES lead_sources, campaign_id uuid REFERENCES campaigns,
  utm jsonb, score int DEFAULT 0,
  next_follow_up_at timestamptz,            -- denormalized for My Day speed
  last_activity_at timestamptz,             -- denormalized for staleness alerts
  stage_entered_at timestamptz,
  custom_fields jsonb DEFAULT '{}',
  merged_into_id uuid REFERENCES leads,     -- lead merge trail
  created_at timestamptz DEFAULT now(), updated_at timestamptz, deleted_at timestamptz
);
CREATE INDEX ix_leads_owner_next ON leads(tenant_id, owner_id, next_follow_up_at);
CREATE INDEX ix_leads_stage ON leads(tenant_id, pipeline_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_stale ON leads(tenant_id, last_activity_at);
CREATE INDEX ix_leads_cf ON leads USING gin(custom_fields);

CREATE TABLE tags (id uuid PRIMARY KEY, tenant_id uuid, name citext, color text);
CREATE TABLE lead_tags (lead_id uuid, tag_id uuid, PRIMARY KEY(lead_id, tag_id));

CREATE TABLE lead_sources (id uuid PRIMARY KEY, tenant_id uuid, name text, channel text);
CREATE TABLE lost_reasons (id uuid PRIMARY KEY, tenant_id uuid, reason text);

CREATE TABLE assignment_rules (
  id uuid PRIMARY KEY, tenant_id uuid, name text, position int, active boolean,
  conditions jsonb,                          -- {source:[..], project:[..], budget_gte:..}
  strategy text,                             -- round_robin|weighted|capacity|geo
  assignee_pool uuid[], office_hours_only boolean, fallback_user_id uuid
);

-- ============ ACTIVITIES (single timeline table, partitioned) ============
CREATE TABLE activities (
  id uuid, tenant_id uuid NOT NULL,
  lead_id uuid, contact_id uuid, booking_id uuid, ticket_id uuid,
  type text NOT NULL,        -- call|note|whatsapp|sms|email|meeting|site_visit|stage_change|task|system
  direction text,            -- inbound|outbound
  actor_id uuid,             -- user who did it (null = system)
  body text, meta jsonb,     -- type-specific payload (see below)
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);          -- monthly partitions: millions of rows stay fast
CREATE INDEX ix_act_lead ON activities(tenant_id, lead_id, occurred_at DESC);

-- Calls get a first-class table (reporting-heavy), mirrored into activities
CREATE TABLE calls (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, user_id uuid,
  provider text,              -- exotel|knowlarity|myoperator|twilio|sip
  provider_call_id text, direction text, from_number text, to_number text,
  status text,                -- completed|missed|busy|failed|no_answer
  started_at timestamptz, answered_at timestamptz, ended_at timestamptz,
  duration_sec int, recording_url text, recording_key text,  -- object-storage key
  disposition text, disposition_note text
);
CREATE INDEX ix_calls_user_day ON calls(tenant_id, user_id, started_at);
CREATE INDEX ix_calls_missed ON calls(tenant_id, status, started_at) WHERE status='missed';

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, assigned_to uuid,
  type text,                  -- call|whatsapp|email|meeting|site_visit
  due_at timestamptz NOT NULL, note text,
  status text DEFAULT 'pending',  -- pending|done|missed|rescheduled
  completed_at timestamptz, outcome text, reschedule_reason text,
  escalated_to uuid
);
CREATE INDEX ix_fu_due ON follow_ups(tenant_id, assigned_to, status, due_at);

CREATE TABLE meetings (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, organizer_id uuid,
  title text, starts_at timestamptz, ends_at timestamptz, location text,
  video_link text, external_calendar_ids jsonb, attendees jsonb, outcome text
);

CREATE TABLE site_visits (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, project_id uuid,
  executive_id uuid, scheduled_at timestamptz,
  status text,                -- scheduled|confirmed|completed|no_show|cancelled
  checkin_at timestamptz, checkin_geo point, checkout_at timestamptz, checkout_geo point,
  notes text, photos jsonb, feedback jsonb,   -- {interest:1-5, objections:[], liked_units:[]}
  is_revisit boolean DEFAULT false
);

-- ============ INVENTORY ============
CREATE TABLE projects (
  id uuid PRIMARY KEY, tenant_id uuid, name text, location jsonb, rera_number text,
  status text, launch_date date, possession_date date, media jsonb, settings jsonb
);
CREATE TABLE towers (id uuid PRIMARY KEY, tenant_id uuid, project_id uuid, name text, floors int);
CREATE TABLE units (
  id uuid PRIMARY KEY, tenant_id uuid, project_id uuid, tower_id uuid,
  floor int, unit_no text, unit_type text,          -- 2BHK|3BHK|plot|shop
  carpet_area numeric, builtup_area numeric, super_area numeric,
  facing text, base_price numeric, plc numeric, floor_rise numeric,
  status text DEFAULT 'available',                   -- available|hold|blocked|booked|sold
  hold_expires_at timestamptz, hold_lead_id uuid,
  price_history jsonb, custom_fields jsonb
);
CREATE UNIQUE INDEX ux_unit ON units(tenant_id, project_id, tower_id, unit_no);

CREATE TABLE payment_plans (
  id uuid PRIMARY KEY, tenant_id uuid, project_id uuid, name text,
  milestones jsonb            -- [{label:'On booking', pct:10, offset_days:0|milestone:'slab_5'}]
);

-- ============ BOOKINGS & PAYMENTS ============
CREATE TABLE bookings (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, unit_id uuid,
  customer_contact_id uuid, co_applicants jsonb,
  agreed_price numeric, discount numeric, discount_approved_by uuid,
  payment_plan_id uuid, status text,       -- booked|agreement|registered|possession|cancelled
  booked_at timestamptz, cancelled_at timestamptz, cancellation_reason text,
  cp_id uuid REFERENCES channel_partners   -- attribution for commission
);

CREATE TABLE payment_schedule (
  id uuid PRIMARY KEY, tenant_id uuid, booking_id uuid,
  milestone_label text, due_date date, amount numeric,
  status text DEFAULT 'pending',           -- pending|demanded|part_paid|paid|overdue
  demanded_at timestamptz
);

CREATE TABLE payments (
  id uuid PRIMARY KEY, tenant_id uuid, booking_id uuid, schedule_id uuid,
  amount numeric, mode text,               -- cheque|neft|upi|razorpay|stripe|cash
  reference text, received_at timestamptz, recorded_by uuid,
  gateway_payload jsonb, tally_synced_at timestamptz
);

-- ============ CHANNEL PARTNERS ============
CREATE TABLE channel_partners (
  id uuid PRIMARY KEY, tenant_id uuid, firm_name text, contact_name text,
  phone text, email citext, rera_number text, kyc_docs jsonb, status text,
  portal_user_id uuid
);
CREATE TABLE cp_commission_slabs (
  id uuid PRIMARY KEY, tenant_id uuid, project_id uuid, cp_id uuid,
  basis text,                 -- pct_of_price|flat
  value numeric, trigger text -- on_booking|on_registration
);
CREATE TABLE cp_payouts (
  id uuid PRIMARY KEY, tenant_id uuid, cp_id uuid, booking_id uuid,
  amount numeric, status text, invoice_doc_id uuid, paid_at timestamptz
);

-- ============ MESSAGING, DOCS, SUPPORT, SYSTEM ============
CREATE TABLE message_threads (
  id uuid PRIMARY KEY, tenant_id uuid, channel text,   -- whatsapp|sms|email
  contact_id uuid, lead_id uuid, external_id text, assigned_to uuid, last_msg_at timestamptz
);
CREATE TABLE messages (
  id uuid PRIMARY KEY, tenant_id uuid, thread_id uuid, direction text,
  body text, media jsonb, template_id uuid, status text,  -- queued|sent|delivered|read|failed
  provider_msg_id text, sent_at timestamptz
);
CREATE TABLE templates (
  id uuid PRIMARY KEY, tenant_id uuid, channel text, name text, body text,
  variables text[], approval_status text     -- WhatsApp/DLT approval
);

CREATE TABLE documents (
  id uuid PRIMARY KEY, tenant_id uuid,
  entity_type text, entity_id uuid,          -- polymorphic: lead|booking|project|cp|ticket
  name text, storage_key text, mime text, size_bytes bigint,
  version int DEFAULT 1, uploaded_by uuid, expires_at date
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY, tenant_id uuid, customer_contact_id uuid, booking_id uuid,
  category text, priority text, status text, assigned_to uuid,
  sla_due_at timestamptz, csat int, created_at timestamptz DEFAULT now()
);

-- ============ FIELD FORCE TRACKING ============
CREATE TABLE field_checkins (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  user_id uuid REFERENCES users,             -- field operator
  manager_id uuid REFERENCES users,          -- auto-routed recipient
  type text NOT NULL,        -- day_start|day_end|site_visit_in|site_visit_out|meeting|adhoc
  site_visit_id uuid REFERENCES site_visits, -- linked when type is visit
  selfie_key text NOT NULL,                  -- object-storage key (camera-only capture)
  captured_at timestamptz NOT NULL,          -- device capture time
  submitted_at timestamptz DEFAULT now(),    -- server receipt (late-sync detection)
  lat double precision, lng double precision,
  accuracy_m numeric, address text,          -- reverse-geocoded
  device_id text, battery_pct int,
  flags jsonb DEFAULT '{}',                  -- {mock_location:true, low_accuracy:true, late_sync:true}
  status text DEFAULT 'ok',                  -- ok|flagged|approved|rejected
  reviewed_by uuid, reviewed_at timestamptz
);
CREATE INDEX ix_fc_user_day ON field_checkins(tenant_id, user_id, captured_at);
CREATE INDEX ix_fc_mgr ON field_checkins(tenant_id, manager_id, submitted_at DESC);
CREATE INDEX ix_fc_flagged ON field_checkins(tenant_id, status) WHERE status='flagged';

CREATE TABLE location_pings (                -- lightweight trail between check-ins,
  id uuid, tenant_id uuid, user_id uuid,     -- active ONLY between day_start & day_end
  lat double precision, lng double precision, accuracy_m numeric,
  at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, at, id)
) PARTITION BY RANGE (at);                   -- high-volume; monthly partitions, short retention

CREATE TABLE tracking_consents (
  id uuid PRIMARY KEY, tenant_id uuid, user_id uuid,
  consented_at timestamptz, policy_version text, revoked_at timestamptz
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY, tenant_id uuid, name text, channel text,
  budget numeric, spend numeric, starts_on date, ends_on date, meta jsonb
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, type text,
  title text, body text, entity_type text, entity_id uuid,
  read_at timestamptz, created_at timestamptz DEFAULT now()
);

CREATE TABLE custom_field_defs (
  id uuid PRIMARY KEY, tenant_id uuid, entity text, key text, label text,
  field_type text, options jsonb, required boolean, position int
);

CREATE TABLE audit_log (
  id uuid, tenant_id uuid, actor_id uuid, action text,
  entity_type text, entity_id uuid, before jsonb, after jsonb, ip inet,
  at timestamptz DEFAULT now(), PRIMARY KEY (tenant_id, at, id)
) PARTITION BY RANGE (at);

CREATE TABLE integration_configs (
  id uuid PRIMARY KEY, tenant_id uuid, provider text,  -- exotel|meta_wa|razorpay|...
  credentials_enc bytea, settings jsonb, status text
);
```

## Scale & Performance Strategy

| Concern | Approach |
|---|---|
| Millions of leads | Composite `(tenant_id, …)` indexes everywhere; RLS keeps tenants isolated; partial indexes on hot predicates (`status='missed'`, `deleted_at IS NULL`) |
| Timeline & audit growth | `activities` and `audit_log` range-partitioned monthly; old partitions moved to cheap storage |
| Search | Postgres FTS for v1 → OpenSearch/Meilisearch mirror for global search & fuzzy dedupe at scale |
| List screens & dashboards | Denormalized counters (`next_follow_up_at`, `last_activity_at`), materialized views refreshed by workers for funnel/ROI reports |
| Analytics | CDC (Debezium) → ClickHouse for the reporting warehouse once row counts exceed ~50M |
| Recordings & media | Object storage (S3-compatible); DB stores keys only; signed URLs for playback |
| Dedupe at capture | Unique `(tenant_id, phone)` on `contact_phones` + normalized E.164; fuzzy pass async |
| Concurrency on units | `SELECT … FOR UPDATE` on unit hold/booking; hold expiry via scheduled worker |
