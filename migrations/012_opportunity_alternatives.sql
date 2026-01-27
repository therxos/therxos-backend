-- Migration: Add opportunity alternatives/deduplication system
-- Date: 2026-01-27
-- Purpose: Handle duplicate opportunities by keeping the most valuable as primary
--          and storing alternatives for fallback options

-- Add columns to track primary/alternative relationships
ALTER TABLE opportunities
ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS primary_opportunity_id UUID REFERENCES opportunities(opportunity_id),
ADD COLUMN IF NOT EXISTS alternative_rank INTEGER DEFAULT 1;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_opportunities_primary ON opportunities(patient_id, is_primary) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS idx_opportunities_alternatives ON opportunities(primary_opportunity_id) WHERE primary_opportunity_id IS NOT NULL;

COMMENT ON COLUMN opportunities.is_primary IS 'True if this is the primary (most valuable) opportunity for this patient/trigger combination';
COMMENT ON COLUMN opportunities.primary_opportunity_id IS 'References the primary opportunity if this is an alternative';
COMMENT ON COLUMN opportunities.alternative_rank IS 'Rank among alternatives (1 = primary, 2 = first alternative, etc.)';

-- Create a view for active opportunities (only primaries, excludes alternatives)
CREATE OR REPLACE VIEW active_opportunities AS
SELECT o.*, p.first_name, p.last_name, p.dob
FROM opportunities o
JOIN patients p ON p.patient_id = o.patient_id
WHERE o.is_primary = true
  AND NOT EXISTS (
    SELECT 1 FROM data_quality_issues dqi
    WHERE dqi.opportunity_id = o.opportunity_id
    AND dqi.status = 'pending'
  );

-- Function to identify and mark duplicate opportunities
-- Groups by patient + therapeutic category and keeps highest value as primary
CREATE OR REPLACE FUNCTION deduplicate_opportunities(p_pharmacy_id UUID DEFAULT NULL)
RETURNS TABLE(
  patients_processed INTEGER,
  duplicates_found INTEGER,
  alternatives_created INTEGER
) AS $$
DECLARE
  v_patients_processed INTEGER := 0;
  v_duplicates_found INTEGER := 0;
  v_alternatives_created INTEGER := 0;
  v_patient RECORD;
  v_opp RECORD;
  v_rank INTEGER;
  v_primary_id UUID;
BEGIN
  -- Find patients with potential duplicates (same therapeutic area)
  FOR v_patient IN
    SELECT DISTINCT o.patient_id, o.pharmacy_id
    FROM opportunities o
    WHERE o.status = 'Not Submitted'
      AND o.is_primary = true
      AND (p_pharmacy_id IS NULL OR o.pharmacy_id = p_pharmacy_id)
    GROUP BY o.patient_id, o.pharmacy_id
    HAVING COUNT(*) > 1
  LOOP
    v_patients_processed := v_patients_processed + 1;

    -- Group opportunities by therapeutic category
    -- Statins: pitavastatin, atorvastatin, rosuvastatin, simvastatin, etc.
    -- Diabetes supplies: lancets, pen needles, test strips
    -- etc.

    -- For now, identify exact duplicates (same recommended drug or overlapping therapy)
    v_rank := 0;
    v_primary_id := NULL;

    FOR v_opp IN
      SELECT opportunity_id, recommended_drug_name, annual_margin_gain, trigger_type
      FROM opportunities
      WHERE patient_id = v_patient.patient_id
        AND pharmacy_id = v_patient.pharmacy_id
        AND status = 'Not Submitted'
        AND is_primary = true
      ORDER BY annual_margin_gain DESC NULLS LAST
    LOOP
      v_rank := v_rank + 1;

      IF v_rank = 1 THEN
        -- This is the primary (highest value)
        v_primary_id := v_opp.opportunity_id;
        UPDATE opportunities
        SET alternative_rank = 1
        WHERE opportunity_id = v_opp.opportunity_id;
      ELSE
        -- This is an alternative
        v_duplicates_found := v_duplicates_found + 1;
        v_alternatives_created := v_alternatives_created + 1;

        UPDATE opportunities
        SET is_primary = false,
            primary_opportunity_id = v_primary_id,
            alternative_rank = v_rank
        WHERE opportunity_id = v_opp.opportunity_id;
      END IF;
    END LOOP;
  END LOOP;

  RETURN QUERY SELECT v_patients_processed, v_duplicates_found, v_alternatives_created;
END;
$$ LANGUAGE plpgsql;

-- Function to get alternatives for an opportunity
CREATE OR REPLACE FUNCTION get_opportunity_alternatives(p_opportunity_id UUID)
RETURNS TABLE(
  opportunity_id UUID,
  recommended_drug_name TEXT,
  annual_margin_gain NUMERIC,
  trigger_type TEXT,
  alternative_rank INTEGER
) AS $$
BEGIN
  -- Get the primary opportunity ID
  RETURN QUERY
  WITH primary_opp AS (
    SELECT COALESCE(o.primary_opportunity_id, o.opportunity_id) as pid
    FROM opportunities o
    WHERE o.opportunity_id = p_opportunity_id
  )
  SELECT
    o.opportunity_id,
    o.recommended_drug_name,
    o.annual_margin_gain,
    o.trigger_type,
    o.alternative_rank
  FROM opportunities o, primary_opp
  WHERE (o.opportunity_id = primary_opp.pid OR o.primary_opportunity_id = primary_opp.pid)
  ORDER BY o.alternative_rank;
END;
$$ LANGUAGE plpgsql;

-- Function to promote an alternative to primary (when user prefers a different option)
CREATE OR REPLACE FUNCTION promote_alternative_to_primary(p_alternative_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_primary_id UUID;
  v_patient_id UUID;
BEGIN
  -- Get the current primary and patient
  SELECT primary_opportunity_id, patient_id INTO v_primary_id, v_patient_id
  FROM opportunities
  WHERE opportunity_id = p_alternative_id;

  IF v_primary_id IS NULL THEN
    -- Already primary
    RETURN false;
  END IF;

  -- Demote current primary to alternative
  UPDATE opportunities
  SET is_primary = false,
      primary_opportunity_id = p_alternative_id,
      alternative_rank = (SELECT MAX(alternative_rank) + 1 FROM opportunities WHERE primary_opportunity_id = v_primary_id OR opportunity_id = v_primary_id)
  WHERE opportunity_id = v_primary_id;

  -- Promote the alternative to primary
  UPDATE opportunities
  SET is_primary = true,
      primary_opportunity_id = NULL,
      alternative_rank = 1
  WHERE opportunity_id = p_alternative_id;

  -- Update all other alternatives to point to new primary
  UPDATE opportunities
  SET primary_opportunity_id = p_alternative_id
  WHERE primary_opportunity_id = v_primary_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql;
