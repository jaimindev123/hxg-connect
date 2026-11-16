-- =====================================================================
-- 012 — Supabase hardening. Supabase publishes the public schema through
-- its Data API and grants its anon/authenticated roles access to new
-- tables and functions. HXG Connect never uses that API, and some of our
-- objects (the tenants directory, webhook_target) must never be reachable
-- through it. Strip those grants now and for future objects. No-op on
-- plain PostgreSQL, where these roles don't exist.
-- =====================================================================
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA platform FROM %I', r);
    END IF;
  END LOOP;
END $$;
