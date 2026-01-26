-- Migration: Create processed_files table for OneDrive integration
-- This tracks which files have been processed to avoid duplicates

CREATE TABLE IF NOT EXISTS processed_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'onedrive',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_processed_files_source_date
ON processed_files(source, processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_processed_files_file_id
ON processed_files(file_id);
