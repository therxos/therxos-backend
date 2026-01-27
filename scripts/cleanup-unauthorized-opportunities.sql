-- Cleanup Unauthorized Opportunities
-- Run this in Supabase SQL Editor
-- Generated: 2026-01-27

-- STEP 1: Review opportunities to be deleted
SELECT
  o.recommended_drug_name,
  ph.pharmacy_name,
  COUNT(*) as count
FROM opportunities o
JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
WHERE o.recommended_drug_name IN ('Low-dose Aspirin', 'Naloxone (Narcan)')
GROUP BY o.recommended_drug_name, ph.pharmacy_name
ORDER BY o.recommended_drug_name, count DESC;

-- STEP 2: Delete unauthorized opportunities
-- Low-dose Aspirin: 1,586 total
-- Naloxone (Narcan): 319 total (your trigger is Kloxxado, not generic Narcan)

DELETE FROM opportunities
WHERE recommended_drug_name IN ('Low-dose Aspirin', 'Naloxone (Narcan)');

-- STEP 3: Verify deletion
SELECT
  recommended_drug_name,
  COUNT(*)
FROM opportunities
WHERE recommended_drug_name IN ('Low-dose Aspirin', 'Naloxone (Narcan)')
GROUP BY recommended_drug_name;
