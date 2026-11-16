-- =====================================================================
-- 014 — Lead connectors (WordPress, Shopify, IndiaMART, JustDial, Zapier…).
-- Platforms retry deliveries; this index makes "have we had this one?" cheap.
-- =====================================================================
CREATE INDEX ix_webhook_events_ext_id ON webhook_events (tenant_id, provider, (payload->>'ext_id'))
  WHERE payload ? 'ext_id';
