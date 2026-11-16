-- =====================================================================
-- 003 — Checks the tenant guard runs on every request
-- =====================================================================

-- Support session still valid? Checked on EVERY impersonated request, so
-- a client admin ending the session cuts access instantly — not at expiry.
CREATE FUNCTION impersonation_active(p_session uuid, p_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.impersonation_sessions
    WHERE id = p_session AND tenant_id = p_tenant
      AND status = 'approved' AND expires_at > now())
$$;

-- Client admin can end an approved session early.
CREATE FUNCTION tenant_end_impersonation(p_session uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  UPDATE platform.impersonation_sessions SET status = 'ended'
   WHERE id = p_session AND tenant_id = app_tenant() AND status = 'approved';
  RETURN FOUND;
END $$;

-- tenant_state now also returns trial_ends_at so the guard can lock
-- expired trials. Return type changed, so drop and recreate.
DROP FUNCTION tenant_state(uuid);
CREATE FUNCTION tenant_state(p_tenant uuid)
RETURNS TABLE (id uuid, status text, trial_ends_at timestamptz, features jsonb, limits jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
  SELECT t.id, t.status, t.trial_ends_at,
         p.features || t.feature_overrides, p.limits || t.limit_overrides
  FROM tenants t JOIN platform.plans p ON p.id = t.plan_id
  WHERE t.id = p_tenant
$$;

REVOKE ALL ON FUNCTION impersonation_active(uuid, uuid), tenant_end_impersonation(uuid),
  tenant_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION impersonation_active(uuid, uuid), tenant_end_impersonation(uuid),
  tenant_state(uuid) TO hxg_app;
