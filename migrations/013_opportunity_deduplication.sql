-- Migration: Add trigger_group to opportunities and deduplication support
-- Date: 2026-01-27

-- Add trigger_group column to opportunities for therapeutic grouping
ALTER TABLE opportunities
ADD COLUMN IF NOT EXISTS trigger_group TEXT;

-- Create index for faster duplicate detection
CREATE INDEX IF NOT EXISTS idx_opportunities_patient_group
ON opportunities(patient_id, trigger_group)
WHERE status = 'Not Submitted' AND trigger_group IS NOT NULL;

-- Therapeutic category mappings for deduplication
-- Opportunities in the same category for the same patient should be consolidated
CREATE TABLE IF NOT EXISTS therapeutic_categories (
  category_id SERIAL PRIMARY KEY,
  category_name TEXT NOT NULL UNIQUE,
  description TEXT,
  drug_patterns TEXT[], -- Patterns to match drug names
  trigger_groups TEXT[] -- Matching trigger_group values
);

-- Insert default therapeutic categories for deduplication
INSERT INTO therapeutic_categories (category_name, description, drug_patterns, trigger_groups) VALUES
  ('Statins', 'HMG-CoA reductase inhibitors for cholesterol',
   ARRAY['atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin', 'lovastatin', 'fluvastatin', 'pitavastatin'],
   ARRAY['statins', 'statin', 'cholesterol']),
  ('Diabetes Supplies', 'Blood glucose monitoring supplies',
   ARRAY['lancet', 'pen needle', 'test strip', 'glucose'],
   ARRAY['lancets', 'pen_needles', 'test_strips', 'dme_lancets', 'dme_pen_needles']),
  ('ACE Inhibitors', 'Angiotensin converting enzyme inhibitors',
   ARRAY['lisinopril', 'enalapril', 'ramipril', 'benazepril', 'captopril'],
   ARRAY['ace_inhibitors', 'ace']),
  ('ARBs', 'Angiotensin receptor blockers',
   ARRAY['losartan', 'valsartan', 'irbesartan', 'olmesartan', 'candesartan'],
   ARRAY['arbs', 'arb']),
  ('PPIs', 'Proton pump inhibitors',
   ARRAY['omeprazole', 'esomeprazole', 'lansoprazole', 'pantoprazole', 'rabeprazole'],
   ARRAY['ppis', 'ppi'])
ON CONFLICT (category_name) DO NOTHING;

-- Function to deduplicate opportunities by keeping highest value per therapeutic category
CREATE OR REPLACE FUNCTION deduplicate_patient_opportunities(
  p_pharmacy_id UUID DEFAULT NULL,
  p_dry_run BOOLEAN DEFAULT true
)
RETURNS TABLE(
  patient_id UUID,
  patient_name TEXT,
  category TEXT,
  opportunities_before INTEGER,
  opportunities_after INTEGER,
  kept_opportunity_id UUID,
  kept_drug TEXT,
  kept_value NUMERIC,
  removed_count INTEGER
) AS $$
DECLARE
  v_patient RECORD;
  v_category RECORD;
  v_best RECORD;
  v_removed INTEGER;
BEGIN
  -- Find patients with multiple Not Submitted opportunities
  FOR v_patient IN
    SELECT DISTINCT o.patient_id, o.pharmacy_id,
           p.first_name || ' ' || p.last_name as patient_name
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.status = 'Not Submitted'
      AND (p_pharmacy_id IS NULL OR o.pharmacy_id = p_pharmacy_id)
    GROUP BY o.patient_id, o.pharmacy_id, p.first_name, p.last_name
    HAVING COUNT(*) > 1
  LOOP
    -- Check each therapeutic category
    FOR v_category IN
      SELECT tc.category_name, tc.drug_patterns
      FROM therapeutic_categories tc
    LOOP
      -- Find opportunities matching this category for this patient
      SELECT
        o.opportunity_id,
        o.recommended_drug_name,
        o.annual_margin_gain,
        COUNT(*) OVER() as total_in_category
      INTO v_best
      FROM opportunities o
      WHERE o.patient_id = v_patient.patient_id
        AND o.status = 'Not Submitted'
        AND EXISTS (
          SELECT 1 FROM unnest(v_category.drug_patterns) pattern
          WHERE LOWER(o.recommended_drug_name) LIKE '%' || LOWER(pattern) || '%'
             OR LOWER(o.current_drug_name) LIKE '%' || LOWER(pattern) || '%'
        )
      ORDER BY o.annual_margin_gain DESC NULLS LAST
      LIMIT 1;

      -- If we found multiple opportunities in this category
      IF v_best IS NOT NULL AND v_best.total_in_category > 1 THEN
        v_removed := v_best.total_in_category - 1;

        -- Return the info
        patient_id := v_patient.patient_id;
        patient_name := v_patient.patient_name;
        category := v_category.category_name;
        opportunities_before := v_best.total_in_category;
        opportunities_after := 1;
        kept_opportunity_id := v_best.opportunity_id;
        kept_drug := v_best.recommended_drug_name;
        kept_value := v_best.annual_margin_gain;
        removed_count := v_removed;
        RETURN NEXT;

        -- If not dry run, actually delete the duplicates
        IF NOT p_dry_run THEN
          DELETE FROM opportunities
          WHERE patient_id = v_patient.patient_id
            AND status = 'Not Submitted'
            AND opportunity_id != v_best.opportunity_id
            AND EXISTS (
              SELECT 1 FROM unnest(v_category.drug_patterns) pattern
              WHERE LOWER(recommended_drug_name) LIKE '%' || LOWER(pattern) || '%'
                 OR LOWER(current_drug_name) LIKE '%' || LOWER(pattern) || '%'
            );
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deduplicate_patient_opportunities IS
'Removes duplicate opportunities within the same therapeutic category per patient, keeping the highest value one.
 Use p_dry_run = true (default) to preview changes, p_dry_run = false to actually delete duplicates.';
