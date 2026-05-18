CREATE TABLE instruments (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  indices TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instruments_name_lower ON instruments (LOWER(name));
CREATE INDEX idx_instruments_indices ON instruments USING GIN (indices);

ALTER TABLE instruments ENABLE ROW LEVEL SECURITY;

-- Public reference data: any signed-in user can read; nobody can write
-- (we seed via privileged jobs only).
CREATE POLICY "instruments_read_all"
  ON instruments FOR SELECT
  TO authenticated, anon
  USING (true);

-- Seed data lives in data/instruments/{spx,ndx}.json and is loaded by
-- scripts/setup.mjs (npm run setup) after migrations. This keeps schema and
-- data on separate axes — migrations describe structure, JSON files describe
-- content.
