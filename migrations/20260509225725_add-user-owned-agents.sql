-- Two changes in one migration:
--   (a) Reduce defaults from 9 to 3 (one model per strategy).
--   (b) Allow signed-in users to own custom agents.
--
-- Default agents (the three left behind) carry user_id = NULL and are
-- readable by everyone. User-owned agents have user_id = the owner, are
-- readable only by their owner, and the owner can also update/delete them.
-- Their positions / decisions / equity snapshots stay public-read for
-- simplicity (acceptable since this is a paper-trading experiment app).

-- 1) Drop the 6 matrix off-diagonal agents. CASCADE removes their (already
-- empty) positions / decisions / equity rows.
DELETE FROM agents
  WHERE slug IN (
    'theta-gemini','theta-gpt',
    'vega-sonnet','vega-gpt',
    'delta-sonnet','delta-gemini'
  );

-- 2) Add ownership column. NULL means "system default; visible to everyone".
ALTER TABLE agents
  ADD COLUMN user_id UUID NULL REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX idx_agents_user_id ON agents (user_id);

-- 3) Replace the read-all policy with scoped policies.
DROP POLICY IF EXISTS "agents_read_all" ON agents;

-- Anyone (anon + authed) can read default agents.
CREATE POLICY "agents_read_defaults"
  ON agents FOR SELECT
  TO authenticated, anon
  USING (user_id IS NULL);

-- Authed users can additionally read agents they own.
CREATE POLICY "agents_read_own"
  ON agents FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Authed users can create their own agents.
CREATE POLICY "agents_insert_own"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Owners can edit / delete their own custom agents.
CREATE POLICY "agents_update_own"
  ON agents FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "agents_delete_own"
  ON agents FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
