-- Dated forward-looking catalysts the day's articles mention (product events,
-- court dates, regulatory decisions, investor days). The rest of the digest
-- describes what already happened, so nothing else carries a future date.
ALTER TABLE news_analyses ADD COLUMN upcoming_catalysts JSONB NOT NULL DEFAULT '[]';
