-- Performance indexes for common query patterns
-- These cover the most frequent queries in analytics, dashboard, and opportunities

-- Opportunities: pharmacy + status (used in every dashboard/analytics query)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_opportunities_pharmacy_status
  ON opportunities(pharmacy_id, status);

-- Opportunities: pharmacy + created_at for trend queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_opportunities_pharmacy_created
  ON opportunities(pharmacy_id, created_at DESC);

-- Opportunities: patient + status for patient profile queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_opportunities_patient_status
  ON opportunities(patient_id, status);

-- Prescriptions: pharmacy + dispensed_date (GP metrics, analytics)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prescriptions_pharmacy_date
  ON prescriptions(pharmacy_id, dispensed_date DESC);

-- Prescriptions: pharmacy + BIN + date for BIN analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prescriptions_pharmacy_bin_date
  ON prescriptions(pharmacy_id, insurance_bin, dispensed_date DESC);

-- Data quality issues: opportunity_id + status (the repeated subquery filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dqi_opportunity_status
  ON data_quality_issues(opportunity_id, status);

-- Patients: pharmacy_id for patient counts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_patients_pharmacy
  ON patients(pharmacy_id);

-- Prescriptions: prescription_id for opportunity JOINs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prescriptions_id
  ON prescriptions(prescription_id);

-- Trigger bin values: composite for the lateral join lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tbv_trigger_bin_group
  ON trigger_bin_values(trigger_id, insurance_bin, insurance_group);
