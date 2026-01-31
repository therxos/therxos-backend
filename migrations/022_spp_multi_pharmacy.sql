-- Fix multi-pharmacy SPP polling: allow same email to be tracked per-pharmacy
-- Previously, one pharmacy polling first would consume all SPP emails globally

-- Drop old unique constraint on message_id alone
ALTER TABLE processed_emails DROP CONSTRAINT IF EXISTS processed_emails_message_id_key;

-- Add per-pharmacy tracking: same email can be processed by different pharmacies
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_emails_msg_pharmacy
  ON processed_emails(message_id, pharmacy_id);

-- Set SPP report identifiers for existing pharmacies
-- Bravo's PioneerRx report is named "daily list 2"
-- Noor's PioneerRx report is named "therxos-noor"
UPDATE pharmacies
SET settings = COALESCE(settings, '{}'::jsonb) || '{"spp_report_name": "daily list 2"}'::jsonb
WHERE pharmacy_name ILIKE '%bravo%';

UPDATE pharmacies
SET settings = COALESCE(settings, '{}'::jsonb) || '{"spp_report_name": "therxos-noor"}'::jsonb
WHERE pharmacy_name ILIKE '%noor%';
