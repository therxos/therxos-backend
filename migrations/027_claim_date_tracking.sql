-- Add most_recent_claim column to track when the coverage data came from
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS most_recent_claim DATE;

-- Add claim_date to opportunities for display purposes
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS claim_date DATE;

COMMENT ON COLUMN trigger_bin_values.most_recent_claim IS 'Date of the most recent claim used to calculate coverage data';
COMMENT ON COLUMN opportunities.claim_date IS 'Date of the claim that verified coverage for this opportunity';
