-- =====================================================================
-- 016 — Two-step sign-in for platform staff (authenticator app codes).
-- The secret is sealed with ENCRYPTION_KEY; backup codes are stored hashed.
-- =====================================================================
ALTER TABLE platform.users
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint NOT NULL DEFAULT 0,
  ADD COLUMN totp_backup     jsonb  NOT NULL DEFAULT '[]';
