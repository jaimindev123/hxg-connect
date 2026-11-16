-- =====================================================================
-- 015 — Plans listed two features that don't exist as switches: single
-- sign-on (not built) and API access (website form keys are open to every
-- plan). A price list must not promise what the product doesn't gate.
-- =====================================================================
UPDATE platform.plans SET features = features - 'sso' - 'api_access';
UPDATE tenants SET feature_overrides = feature_overrides - 'sso' - 'api_access' WHERE feature_overrides ?| ARRAY['sso', 'api_access'];
