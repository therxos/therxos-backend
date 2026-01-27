-- Migration: Add document tracking fields to pharmacies table
-- Date: 2026-01-27

-- Add columns to track when documents were signed
ALTER TABLE pharmacies
ADD COLUMN IF NOT EXISTS baa_signed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS service_agreement_signed_at TIMESTAMPTZ;

-- Add stripe_customer_id to clients if not exists
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_pharmacies_baa_signed ON pharmacies(baa_signed_at) WHERE baa_signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacies_sa_signed ON pharmacies(service_agreement_signed_at) WHERE service_agreement_signed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

COMMENT ON COLUMN pharmacies.baa_signed_at IS 'Date when Business Associate Agreement was signed';
COMMENT ON COLUMN pharmacies.service_agreement_signed_at IS 'Date when Service Agreement was signed';
COMMENT ON COLUMN clients.stripe_customer_id IS 'Stripe customer ID for billing';
