-- Migration 023: Add keyword match mode and refine BIN/group inclusion/exclusion model

-- Add keyword_match_mode to control whether detection_keywords use ANY or ALL matching
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS keyword_match_mode TEXT DEFAULT 'any';
-- 'any' = drug matches if ANY keyword matches (current behavior)
-- 'all' = drug matches only if ALL keywords match

-- Rename bin_restrictions to bin_inclusions for clarity
ALTER TABLE triggers RENAME COLUMN bin_restrictions TO bin_inclusions;

-- Add new columns for exclusions/inclusions
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS bin_exclusions TEXT[];
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS group_inclusions TEXT[];
-- group_exclusions already exists
-- contract_prefix_exclusions already exists
