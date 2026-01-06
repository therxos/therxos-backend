-- Migration: Add tables for Gmail polling and automation features
-- Run this in Supabase SQL Editor

-- System settings table for OAuth tokens and configuration
CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key VARCHAR(255) UNIQUE NOT NULL,
  setting_value TEXT,
  token_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(setting_key);

-- Processed emails table to track which emails have been handled
CREATE TABLE IF NOT EXISTS processed_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID UNIQUE NOT NULL,
  message_id VARCHAR(255) UNIQUE NOT NULL,
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),
  job_id UUID,
  subject TEXT,
  sender TEXT,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  results JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for processed emails
CREATE INDEX IF NOT EXISTS idx_processed_emails_message_id ON processed_emails(message_id);
CREATE INDEX IF NOT EXISTS idx_processed_emails_pharmacy ON processed_emails(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_processed_emails_processed_at ON processed_emails(processed_at);

-- Poll runs table to track automation job history
CREATE TABLE IF NOT EXISTS poll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID UNIQUE NOT NULL,
  run_type VARCHAR(50) NOT NULL, -- 'spp_poll', 'auto_complete', 'scan'
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'running', -- 'running', 'completed', 'failed'
  summary JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for poll runs
CREATE INDEX IF NOT EXISTS idx_poll_runs_run_id ON poll_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_poll_runs_pharmacy ON poll_runs(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_poll_runs_started_at ON poll_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_poll_runs_type ON poll_runs(run_type);

-- Add first_name and last_name columns to patients if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'patients' AND column_name = 'first_name') THEN
    ALTER TABLE patients ADD COLUMN first_name VARCHAR(255);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'patients' AND column_name = 'last_name') THEN
    ALTER TABLE patients ADD COLUMN last_name VARCHAR(255);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'patients' AND column_name = 'date_of_birth') THEN
    ALTER TABLE patients ADD COLUMN date_of_birth DATE;
  END IF;
END $$;

-- Add recommended_drug column to opportunities if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'opportunities' AND column_name = 'recommended_drug') THEN
    ALTER TABLE opportunities ADD COLUMN recommended_drug VARCHAR(255);
  END IF;
END $$;

-- Add ingestion_date to prescriptions if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'prescriptions' AND column_name = 'ingestion_date') THEN
    ALTER TABLE prescriptions ADD COLUMN ingestion_date TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- Create ingestion_logs table if it doesn't exist
CREATE TABLE IF NOT EXISTS ingestion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id UUID UNIQUE NOT NULL,
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),
  client_id UUID REFERENCES clients(client_id),
  source_type VARCHAR(50), -- 'csv_upload', 'email_attachment', 'api'
  source_file VARCHAR(255),
  source_email VARCHAR(255),
  status VARCHAR(50) DEFAULT 'processing', -- 'processing', 'completed', 'partial', 'failed'
  total_records INTEGER,
  successful_records INTEGER,
  failed_records INTEGER,
  duplicate_records INTEGER,
  validation_errors JSONB,
  processing_time_ms INTEGER,
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_logs_pharmacy ON ingestion_logs(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_logs_created_at ON ingestion_logs(created_at DESC);

-- Create scan_logs table if it doesn't exist
CREATE TABLE IF NOT EXISTS scan_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID UNIQUE NOT NULL,
  scan_batch_id VARCHAR(100) NOT NULL,
  scan_type VARCHAR(50), -- 'nightly_batch', 'manual', 'spp_import'
  pharmacy_ids UUID[],
  status VARCHAR(50) DEFAULT 'running',
  prescriptions_scanned INTEGER,
  opportunities_found INTEGER,
  opportunities_by_type JSONB,
  processing_time_ms INTEGER,
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_batch_id ON scan_logs(scan_batch_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_created_at ON scan_logs(created_at DESC);

-- Grant necessary permissions
GRANT ALL ON system_settings TO authenticated;
GRANT ALL ON processed_emails TO authenticated;
GRANT ALL ON poll_runs TO authenticated;
GRANT ALL ON ingestion_logs TO authenticated;
GRANT ALL ON scan_logs TO authenticated;

-- Success message
DO $$ BEGIN RAISE NOTICE 'Migration completed successfully!'; END $$;
