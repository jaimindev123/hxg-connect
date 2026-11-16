-- =====================================================================
-- 006 — Inventory, site visits, bookings and payments
-- =====================================================================
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  city            text,
  locality        text,
  rera_number     text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('upcoming','active','completed')),
  possession_date date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE towers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  floors     int  NOT NULL CHECK (floors BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tower_id        uuid NOT NULL REFERENCES towers(id) ON DELETE CASCADE,
  floor           int  NOT NULL,
  unit_no         text NOT NULL,
  unit_type       text NOT NULL,                 -- 2BHK, 3BHK, shop...
  carpet_sqft     numeric,
  super_sqft      numeric,
  facing          text,
  base_price      numeric(14,2) NOT NULL CHECK (base_price > 0),
  status          text NOT NULL DEFAULT 'available' CHECK (status IN ('available','hold','booked','blocked')),
  hold_lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,
  hold_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  hold_expires_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tower_id, unit_no)
);
CREATE INDEX ix_units_grid  ON units (tenant_id, tower_id, floor DESC, unit_no);
CREATE INDEX ix_units_match ON units (tenant_id, status, base_price);

CREATE TABLE payment_plans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  milestones jsonb NOT NULL,                     -- [{label, percent, due_days|null}]
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_visits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  executive_id uuid REFERENCES users(id) ON DELETE SET NULL,
  follow_up_id uuid REFERENCES follow_ups(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','no_show','cancelled')),
  checkin_id   uuid REFERENCES field_checkins(id) ON DELETE SET NULL,   -- proof the executive was on site
  interest     int CHECK (interest BETWEEN 1 AND 5),
  notes        text,
  completed_at timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_visits_day ON site_visits (tenant_id, scheduled_at);

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id),
  unit_id         uuid NOT NULL REFERENCES units(id),
  payment_plan_id uuid REFERENCES payment_plans(id),
  applicant       jsonb NOT NULL,                -- {name, phone, email, co_applicant}
  list_price      numeric(14,2) NOT NULL,
  agreed_price    numeric(14,2) NOT NULL CHECK (agreed_price > 0),
  status          text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','agreement','registered','cancelled')),
  booked_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  cancel_reason   text,
  created_by      uuid
);
-- A unit can never carry two live bookings, whatever the application does.
CREATE UNIQUE INDEX ux_bookings_live_unit ON bookings (unit_id) WHERE status <> 'cancelled';

CREATE TABLE payment_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id       uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  seq              int  NOT NULL,
  label            text NOT NULL,
  percent          numeric(6,3) NOT NULL,
  amount           numeric(14,2) NOT NULL,
  due_date         date,                          -- null = due on demand (construction-linked)
  paid_amount      numeric(14,2) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'due' CHECK (status IN ('due','part_paid','paid')),
  payment_link_id  text,
  payment_link_url text
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id          uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  schedule_id         uuid REFERENCES payment_schedule(id) ON DELETE SET NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  mode                text NOT NULL CHECK (mode IN ('cash','cheque','neft','upi','razorpay','other')),
  reference           text,
  razorpay_payment_id text UNIQUE,                -- replayed webhooks can't double-count
  received_at         timestamptz NOT NULL DEFAULT now(),
  recorded_by         uuid
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','towers','units','payment_plans','site_visits',
                           'bookings','payment_schedule','payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hxg_app', t);
  END LOOP;
END $$;
-- Deliberately no hxg_platform grants: inventory and money are client data.

-- Expired holds go back on sale. Runs every minute across all workspaces.
CREATE FUNCTION release_expired_holds() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH r AS (
    UPDATE units SET status = 'available', hold_lead_id = NULL, hold_by = NULL, hold_expires_at = NULL, updated_at = now()
    WHERE status = 'hold' AND hold_expires_at < now() RETURNING 1)
  SELECT count(*)::int FROM r
$$;
REVOKE ALL ON FUNCTION release_expired_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_expired_holds() TO hxg_app;
