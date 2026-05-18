-- Logo URL for each instrument. Populated by scripts/upload-logos.mjs after
-- downloading from Financial Modeling Prep and uploading to the `logos`
-- storage bucket. Frontend uses this for the inline logo on the dashboard,
-- watchlist drawer, and search dropdown.
ALTER TABLE instruments ADD COLUMN logo_url TEXT NULL;
