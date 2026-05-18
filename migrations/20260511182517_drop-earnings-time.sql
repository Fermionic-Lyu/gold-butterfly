-- The BMO/AMC indicator is no longer surfaced anywhere in the UI. Drop the
-- column instead of letting it sit unread.

ALTER TABLE earnings_dates DROP COLUMN time;
