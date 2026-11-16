-- =====================================================================
-- 011 — Found in the full-project audit: hxg_platform could SELECT every
-- column of client users (password_hash, phone) to seed new workspaces.
-- RLS doesn't stop it (the role can set app.tenant_id itself), so narrow
-- it to the columns provisioning actually needs.
-- =====================================================================
REVOKE SELECT ON users FROM hxg_platform;
GRANT SELECT (id, tenant_id, email, status) ON users TO hxg_platform;
