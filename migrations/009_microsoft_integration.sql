-- Migration: Add Microsoft Graph integration support
-- Run this in Supabase SQL Editor

-- Add source column to processed_emails to differentiate Gmail vs Microsoft
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'processed_emails' AND column_name = 'source') THEN
    ALTER TABLE processed_emails ADD COLUMN source VARCHAR(50) DEFAULT 'gmail';
  END IF;
END $$;

-- Create index for source filtering
CREATE INDEX IF NOT EXISTS idx_processed_emails_source ON processed_emails(source);

-- Success message
DO $$ BEGIN RAISE NOTICE 'Microsoft integration migration completed successfully!'; END $$;
