-- Migration: Add pharmacy_inclusions to triggers
-- Date: 2026-01-31
-- Purpose: Allow triggers to be scoped to specific pharmacies
-- If pharmacy_inclusions is empty/null, the trigger applies to ALL active pharmacies (default)
-- If populated, the trigger only runs for those specific pharmacies

ALTER TABLE triggers ADD COLUMN IF NOT EXISTS pharmacy_inclusions UUID[] DEFAULT '{}';

COMMENT ON COLUMN triggers.pharmacy_inclusions IS
'List of pharmacy_ids this trigger applies to. Empty = all pharmacies (default). Populated = only those pharmacies.';
