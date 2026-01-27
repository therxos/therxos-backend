-- Migration: CREATE PERMANENT AUDIT LOG FOR ALL OPPORTUNITY CHANGES
-- Date: 2026-01-27
-- This creates a permanent, immutable audit trail for ALL opportunity changes

-- Create audit log table
CREATE TABLE IF NOT EXISTS opportunity_audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL,
  pharmacy_id UUID NOT NULL,
  patient_id UUID,
  operation VARCHAR(10) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
  old_status TEXT,
  new_status TEXT,
  old_data JSONB, -- Full snapshot of old row
  new_data JSONB, -- Full snapshot of new row
  changed_by UUID, -- User who made the change (if available)
  changed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  change_reason TEXT
);

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_opp_audit_opportunity ON opportunity_audit_log(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opp_audit_pharmacy ON opportunity_audit_log(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_opp_audit_changed_at ON opportunity_audit_log(changed_at);
CREATE INDEX IF NOT EXISTS idx_opp_audit_operation ON opportunity_audit_log(operation);

-- Create trigger function to log ALL changes
CREATE OR REPLACE FUNCTION log_opportunity_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO opportunity_audit_log (
      opportunity_id, pharmacy_id, patient_id, operation,
      new_status, new_data, changed_at
    ) VALUES (
      NEW.opportunity_id, NEW.pharmacy_id, NEW.patient_id, 'INSERT',
      NEW.status, row_to_json(NEW)::JSONB, NOW()
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO opportunity_audit_log (
      opportunity_id, pharmacy_id, patient_id, operation,
      old_status, new_status, old_data, new_data, changed_at
    ) VALUES (
      NEW.opportunity_id, NEW.pharmacy_id, NEW.patient_id, 'UPDATE',
      OLD.status, NEW.status, row_to_json(OLD)::JSONB, row_to_json(NEW)::JSONB, NOW()
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Log the deletion (even though our other trigger prevents actioned deletes)
    INSERT INTO opportunity_audit_log (
      opportunity_id, pharmacy_id, patient_id, operation,
      old_status, old_data, changed_at
    ) VALUES (
      OLD.opportunity_id, OLD.pharmacy_id, OLD.patient_id, 'DELETE',
      OLD.status, row_to_json(OLD)::JSONB, NOW()
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create the audit trigger
DROP TRIGGER IF EXISTS audit_opportunity_changes ON opportunities;
CREATE TRIGGER audit_opportunity_changes
  AFTER INSERT OR UPDATE OR DELETE ON opportunities
  FOR EACH ROW
  EXECUTE FUNCTION log_opportunity_changes();

-- Make the audit log immutable - no updates or deletes allowed
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_audit_log ON opportunity_audit_log;
CREATE TRIGGER protect_audit_log
  BEFORE UPDATE OR DELETE ON opportunity_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_modification();

COMMENT ON TABLE opportunity_audit_log IS
'PERMANENT audit trail of ALL opportunity changes. This table is IMMUTABLE - entries cannot be modified or deleted.';
