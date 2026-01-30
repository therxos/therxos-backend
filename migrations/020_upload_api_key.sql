-- Migration 020: Upload API Key for automated client uploads
-- Each pharmacy gets a unique API key for the auto-upload tool

ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS upload_api_key TEXT;

-- Generate keys for existing pharmacies
UPDATE pharmacies SET upload_api_key = encode(gen_random_bytes(32), 'hex') WHERE upload_api_key IS NULL;
