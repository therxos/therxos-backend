-- Migration: PROTECT ACTIONED OPPORTUNITIES FROM DELETION
-- Date: 2026-01-27
-- CRITICAL: This prevents ANY deletion of opportunities that have been worked on

-- Create a trigger function that prevents deletion of actioned opportunities
CREATE OR REPLACE FUNCTION prevent_actioned_opportunity_deletion()
RETURNS TRIGGER AS $$
BEGIN
  -- If the opportunity status is anything other than 'Not Submitted', prevent deletion
  IF OLD.status != 'Not Submitted' THEN
    RAISE EXCEPTION 'CANNOT DELETE ACTIONED OPPORTUNITY: % (status: %). Actioned opportunities must NEVER be deleted.',
      OLD.opportunity_id, OLD.status;
  END IF;

  -- Allow deletion only for 'Not Submitted' opportunities
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger that runs BEFORE any DELETE on opportunities
DROP TRIGGER IF EXISTS protect_actioned_opportunities ON opportunities;
CREATE TRIGGER protect_actioned_opportunities
  BEFORE DELETE ON opportunities
  FOR EACH ROW
  EXECUTE FUNCTION prevent_actioned_opportunity_deletion();

-- Log this protection was added
COMMENT ON TRIGGER protect_actioned_opportunities ON opportunities IS
'CRITICAL PROTECTION: Prevents deletion of any opportunity with status != Not Submitted.
These represent real work done by pharmacy staff and must NEVER be deleted.';

-- Also add a constraint to prevent status from being changed to NULL or empty
ALTER TABLE opportunities
DROP CONSTRAINT IF EXISTS opportunities_status_not_empty;

ALTER TABLE opportunities
ADD CONSTRAINT opportunities_status_not_empty
CHECK (status IS NOT NULL AND status != '');
