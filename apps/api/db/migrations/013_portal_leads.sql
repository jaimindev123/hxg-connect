-- =====================================================================
-- 013 — Property portal leads arriving by forwarded email. The address's
-- local part is a random lowercase key (mail systems may lowercase it).
-- =====================================================================
CREATE INDEX ix_integrations_email_key ON integrations ((config->>'email_key')) WHERE provider = 'property_portals';

CREATE FUNCTION portal_email_target(p_key text)
RETURNS TABLE (tenant_id uuid, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.tenant_id, i.enabled FROM integrations i
  WHERE i.provider = 'property_portals' AND i.config->>'email_key' = lower(p_key) AND length(p_key) >= 16
$$;
REVOKE ALL ON FUNCTION portal_email_target(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_email_target(text) TO hxg_app;
