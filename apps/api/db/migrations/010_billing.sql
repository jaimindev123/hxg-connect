-- =====================================================================
-- 010 — Subscription billing: GST invoices, payment, dunning
-- Platform-owned tables. Clients reach their own invoices only through
-- API routes that filter by the tenant in their verified token.
-- =====================================================================

-- Set when dunning (not a person) suspended the workspace, so a payment
-- can lift it automatically. Manual suspensions are never auto-lifted.
ALTER TABLE tenants ADD COLUMN billing_hold boolean NOT NULL DEFAULT false;

CREATE TABLE platform.billing_profiles (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  gstin      text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),   -- GST state code: place of supply
  email      citext NOT NULL,
  address    text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- GST needs invoice numbers that are unique and consecutive within each
-- financial year. One row per FY, incremented under a row lock.
CREATE TABLE platform.invoice_counters (
  fy   text PRIMARY KEY,          -- '2026-27'
  last int NOT NULL DEFAULT 0
);

CREATE TABLE platform.invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number              text NOT NULL UNIQUE,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  plan_name           text NOT NULL,
  seats               int  NOT NULL,
  unit_price          numeric(12,2) NOT NULL,
  subtotal            numeric(14,2) NOT NULL,
  cgst                numeric(14,2) NOT NULL DEFAULT 0,
  sgst                numeric(14,2) NOT NULL DEFAULT 0,
  igst                numeric(14,2) NOT NULL DEFAULT 0,
  total               numeric(14,2) NOT NULL,
  buyer               jsonb NOT NULL,                 -- billing profile snapshot at issue time
  seller              jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','void')),
  issued_on           date NOT NULL DEFAULT current_date,
  due_date            date NOT NULL,
  paid_at             timestamptz,
  paid_reference      text,
  razorpay_payment_id text UNIQUE,
  payment_link_url    text,
  void_reason         text
);
-- One live invoice per client per billing month, however often the run fires.
CREATE UNIQUE INDEX ux_invoice_period ON platform.invoices (tenant_id, period_start) WHERE status <> 'void';
CREATE INDEX ix_invoices_due ON platform.invoices (status, due_date);

GRANT SELECT, INSERT, UPDATE ON platform.billing_profiles, platform.invoice_counters, platform.invoices TO hxg_platform;
