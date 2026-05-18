-- The InsForge API_KEY (used by edge functions as the service-role bearer
-- token) authenticates with a role that anon/authenticated grants alone
-- don't cover. Broaden the EXECUTE grant to include project_admin, which
-- matches what the platform's service-role token can switch into.

GRANT EXECUTE ON FUNCTION apply_agent_tick(jsonb) TO project_admin;
