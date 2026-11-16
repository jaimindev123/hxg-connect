# HXG Connect CRM — SaaS Platform Layer (Super Admin → Admin → Client → Users)

The product is sold to many companies. Two completely separate planes:

```
PLATFORM PLANE (your company)                 TENANT PLANE (each client company)
┌──────────────────────────────┐              ┌──────────────────────────────────┐
│ SUPER ADMIN (product owner)  │   manages    │ CLIENT (tenant)                  │
│   └ PLATFORM ADMINS          │ ───────────► │   └ CLIENT OWNER / ADMIN         │
│     · Support  · Sales/CS    │  provisions  │       └ USERS (10 CRM roles:     │
│     · Billing  · Onboarding  │   bills      │         Sales Mgr, TL, Exec,     │
│                              │   supports   │         Telecaller, Finance…)    │
└──────────────────────────────┘              └──────────────────────────────────┘
   admin.hxgconnect.com                          {client}.hxgconnect.com
   (separate app + separate auth realm)          or custom domain (white-label)
```

**Hard rule:** platform users and tenant users live in different auth realms with different login URLs. A platform admin can never be casually inside client data — access happens only through audited, time-boxed **impersonation**.

---

## 1. Roles & What Each Plane Can Do

### Platform plane
| Role | Capabilities |
|---|---|
| **Super Admin** | Everything below + manage platform admins, plans & pricing, feature flags, global settings, danger actions (delete tenant), revenue dashboard |
| **Platform Admin — Sales/CS** | Create trials, convert to paid, manage subscriptions, view usage & health scores, send announcements |
| **Platform Admin — Support** | View tenant config (not lead data), **impersonate with client consent**, reset client-admin access, view error logs for a tenant |
| **Platform Admin — Billing** | Invoices, payments, dunning, plan overrides, credits/refunds |

### Tenant plane
| Role | Capabilities |
|---|---|
| **Client Owner** | The buyer. Billing & subscription self-service, company profile, appoint Client Admins, data export, delete-my-data requests |
| **Client Admin** | Everything inside the CRM: users, roles, teams, pipelines, custom fields, assignment rules, integrations (their own Exotel/WhatsApp/Razorpay credentials), branding |
| **Users** | The existing 10 role presets (Sales Manager … Customer Support), all custom-definable *per client* |

Key consequence: **every configuration in the earlier docs (pipelines, stages, custom fields, roles, assignment rules, templates, integrations) is per-tenant.** Client A's "Site Visit" stage rules never touch Client B's.

---

## 2. Super Admin Console — Feature Set

**Client (Tenant) Management**
- Client directory: company, plan, status (trial / active / past-due / suspended / churned), users, leads, MRR, health score, signup & renewal dates
- Provisioning: create client → choose plan → seed defaults (pipeline, roles, sample data optional) → invite Client Owner → subdomain live in seconds
- Lifecycle: extend trial, upgrade/downgrade, suspend (login blocked, data intact), restore, offboard (grace-period export → scheduled hard delete with legal hold option)
- Per-client overrides: user/lead limits, feature flags, storage quota, API rate limits, custom contract pricing

**Plans & Billing**
- Plan builder: price (₹/user/month or flat), billing cycle, limits (users, leads, storage, WhatsApp msgs, call minutes), feature matrix (e.g., Field Tracking on Growth+ only, CP Portal on Pro+)
- Suggested tiers: **Starter** (5 users, core CRM) · **Growth** (+telephony, WhatsApp, field tracking) · **Pro** (+CP portal, bookings/payments, API) · **Enterprise** (SSO, white-label, dedicated DB, SLA)
- Subscription engine: Razorpay/Stripe subscriptions, proration, invoices (GST-compliant for India), dunning (retry → warn → grace → suspend), coupons, add-ons (extra WhatsApp credits, call minutes)

**Operations & Support**
- **Impersonation**: support admin requests access → client admin approves in-app (or pre-authorized window) → time-boxed session (60 min), banner visible to the admin ("Viewing as Sunrise Realty — read-only"), every action logged to both platform and tenant audit logs
- Tenant health: API error rate, job-queue lag, webhook failures, integration status (WhatsApp token expiring, telephony auth failed) — per client
- Usage metering: leads created, messages sent, call minutes, storage — feeds billing + limit enforcement (soft warn at 80%, hard behavior configurable)
- Announcements: in-app banners / release notes targeted by plan or client
- Churn signals: login decline, feature abandonment, support-ticket spikes → CS task queue

**Platform Analytics**
- MRR/ARR, net revenue retention, trial→paid conversion, churn, ARPA, plan mix, feature adoption across tenants (aggregated, never raw client lead data)

---

## 3. Data Architecture Changes

Multi-tenancy was already designed in (shared schema + `tenant_id` + RLS). The platform layer adds **platform tables that live outside RLS** and are reachable only by the platform app:

```sql
-- ============ PLATFORM PLANE (separate schema: platform.*) ============
CREATE TABLE platform.users (
  id uuid PRIMARY KEY, email citext UNIQUE, name text,
  role text NOT NULL,          -- super_admin|admin_sales|admin_support|admin_billing
  mfa_enforced boolean DEFAULT true, status text, created_at timestamptz
);

-- tenants table (already defined) gains lifecycle + commercial fields:
ALTER TABLE tenants ADD COLUMN
  status text DEFAULT 'trial',            -- trial|active|past_due|suspended|churned
  subdomain citext UNIQUE, custom_domain citext,
  plan_id uuid, trial_ends_at timestamptz,
  limits jsonb,                            -- {users:25, leads:500000, storage_gb:50, wa_msgs:10000}
  feature_flags jsonb,                     -- {field_tracking:true, cp_portal:false,...}
  owner_contact jsonb, onboarded_by uuid,  -- platform.users
  health_score int, churn_risk text;

CREATE TABLE platform.plans (
  id uuid PRIMARY KEY, name text, price_per_user numeric, flat_price numeric,
  currency text DEFAULT 'INR', billing_cycle text,   -- monthly|yearly
  limits jsonb, features jsonb, is_public boolean, position int
);

CREATE TABLE platform.subscriptions (
  id uuid PRIMARY KEY, tenant_id uuid, plan_id uuid,
  gateway text, gateway_sub_id text,       -- razorpay|stripe subscription
  seats int, status text,                  -- trialing|active|past_due|cancelled
  current_period_end timestamptz, cancel_at_period_end boolean,
  overrides jsonb                          -- contract pricing / custom limits
);

CREATE TABLE platform.invoices (
  id uuid PRIMARY KEY, tenant_id uuid, subscription_id uuid,
  number text UNIQUE, amount numeric, tax jsonb,     -- GST breakup
  status text, due_at date, paid_at timestamptz, pdf_key text
);

CREATE TABLE platform.usage_daily (
  tenant_id uuid, day date, metric text,   -- leads_created|wa_msgs|call_min|storage_gb|api_calls
  value numeric, PRIMARY KEY (tenant_id, day, metric)
);

CREATE TABLE platform.impersonation_sessions (
  id uuid PRIMARY KEY, platform_user_id uuid, tenant_id uuid,
  reason text NOT NULL, approved_by uuid,  -- tenant client-admin user id
  mode text DEFAULT 'read_only',           -- read_only|full (super admin only)
  started_at timestamptz, expires_at timestamptz, ended_at timestamptz
);

CREATE TABLE platform.audit_log (
  id uuid, actor_id uuid, action text, tenant_id uuid,
  detail jsonb, at timestamptz DEFAULT now(), PRIMARY KEY (at, id)
) PARTITION BY RANGE (at);
```

**Isolation guarantees**
- Tenant app DB role has **no grant** on `platform.*`; platform app has aggregate-only access to tenant data through defined views/metrics, never ad-hoc queries on leads.
- JWTs are realm-stamped (`realm: platform | tenant`); the API gateway rejects cross-realm tokens.
- Impersonation mints a special short-lived tenant token carrying `impersonator_id` — every audit row written during the session records both identities.
- Enterprise option: move a tenant to a **dedicated database**; the tenant-resolver maps `tenant_id → connection`, nothing else changes (this is why RLS-from-day-one matters).

---

## 4. Platform API (admin.hxgconnect.com/api/v1)

```
POST  /platform/auth/login                        (separate realm, MFA enforced)
GET   /platform/tenants?status=&plan=&q=          directory + health
POST  /platform/tenants                           provision {company, subdomain, plan_id,
                                                   owner:{name,email}, trial_days, seed:"defaults"}
GET   /platform/tenants/{id}                      profile, usage, integration health, timeline
PATCH /platform/tenants/{id}                      limits, feature_flags, status
POST  /platform/tenants/{id}/suspend | /restore | /extend-trial {days}
POST  /platform/tenants/{id}/offboard             {grace_days, export:true}
POST  /platform/tenants/{id}/impersonate          {reason, mode} → pending client approval
                                                  → time-boxed tenant token
GET   /platform/plans   POST /platform/plans      plan builder
GET   /platform/subscriptions/{tenant}  POST …/change-plan  POST …/add-seats
GET   /platform/invoices?status=past_due          dunning queue
GET   /platform/metrics/mrr | /churn | /adoption  revenue analytics
POST  /platform/announcements                     targeted banners
Webhooks in: /platform/billing/razorpay | /stripe  (subscription lifecycle)
```

Tenant-side additions (Client Owner self-service):
```
GET/POST /billing/subscription        current plan, upgrade, seats, payment method
GET      /billing/invoices            download GST invoices
GET      /billing/usage               live usage vs limits
```

---

## 5. Signup & Provisioning Flow

1. Prospect signs up on the marketing site (or a Platform Admin creates a trial) → chooses plan → company + owner details.
2. System creates tenant row, subdomain, seeds default pipeline/roles/settings, sends owner invite → **live in < 30 seconds**, no engineering involvement.
3. Client Owner completes onboarding wizard: team invites, project setup, integration credentials (their own Exotel / WhatsApp / Razorpay accounts — the platform never shares one telephony account across clients).
4. Day-12 trial nudge → convert via self-serve checkout or CS-assisted → subscription active → limits/flags applied from plan.
5. Non-payment: dunning ladder → suspend (data intact) → offboard with export after grace.

---

## 6. Roadmap Impact

The platform layer slots into the phase plan as follows: Phase 0 already includes multi-tenancy + RLS (unchanged, now explicitly realm-split); **Phase 1 adds** minimal tenant provisioning + the tenant directory (needed for alpha clients anyway); **Phase 2 adds** plans, subscriptions, self-serve billing, usage metering; **Phase 3 adds** impersonation with consent, tenant health, dunning automation; **Phase 5** brings white-labeling, dedicated-DB tenants, SSO, and regional data residency. Net addition ≈ 4–5 engineering weeks spread across phases, because the tenancy foundation was already in the architecture.
