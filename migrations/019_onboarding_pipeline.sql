-- Migration 019: Self-Service Onboarding Pipeline
-- Adds columns to clients table for tracking onboarding progress

-- Calendly integration
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calendly_event_uri TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calendly_invitee_uri TEXT;

-- Contact info from Calendly
ALTER TABLE clients ADD COLUMN IF NOT EXISTS primary_contact_first_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS primary_contact_last_name TEXT;

-- BAA acceptance tracking
ALTER TABLE clients ADD COLUMN IF NOT EXISTS baa_accepted_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS baa_accepted_ip TEXT;

-- Service agreement signing
ALTER TABLE clients ADD COLUMN IF NOT EXISTS agreement_signed_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS agreement_signed_ip TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS agreement_signer_name TEXT;

-- Stripe payment tracking (separate from existing stripe_customer_id)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_payment_at TIMESTAMPTZ;

-- Onboarding completion
ALTER TABLE clients ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Delayed login email
ALTER TABLE clients ADD COLUMN IF NOT EXISTS login_email_sent BOOLEAN DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS login_email_scheduled_at TIMESTAMPTZ;

-- Index for the delayed email cron job
CREATE INDEX IF NOT EXISTS idx_clients_pending_login_email
  ON clients (login_email_scheduled_at)
  WHERE login_email_sent = false AND status = 'new';
