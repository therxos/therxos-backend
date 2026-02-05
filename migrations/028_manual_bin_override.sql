-- Add manual override fields to trigger_bin_values
-- Allows admins to override auto-detected best NDC, drug name, and GP values

ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS is_manual_override BOOLEAN DEFAULT FALSE;
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS manual_ndc TEXT;
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS manual_drug_name TEXT;
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS manual_gp_value NUMERIC(10,2);
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS manual_note TEXT;
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS manual_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN trigger_bin_values.is_manual_override IS 'When true, use manual_* values instead of auto-detected values';
COMMENT ON COLUMN trigger_bin_values.manual_ndc IS 'Admin-specified NDC to use instead of auto-detected best_ndc';
COMMENT ON COLUMN trigger_bin_values.manual_drug_name IS 'Admin-specified drug name to use instead of auto-detected best_drug_name';
COMMENT ON COLUMN trigger_bin_values.manual_gp_value IS 'Admin-specified GP value to use instead of auto-detected gp_value';
COMMENT ON COLUMN trigger_bin_values.manual_note IS 'Note explaining why manual override was set (e.g. "from UgoRx")';
