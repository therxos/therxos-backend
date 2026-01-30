-- Migration 018: Fax Integration
-- Adds prescriber fax directory and fax log tables for Notifyre integration
-- Date: 2026-01-30

-- Prescriber fax directory - saves fax numbers for reuse per pharmacy
CREATE TABLE IF NOT EXISTS prescriber_fax_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(pharmacy_id),
  prescriber_npi TEXT NOT NULL,
  prescriber_name TEXT,
  fax_number TEXT NOT NULL,
  created_by UUID REFERENCES users(user_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pharmacy_id, prescriber_npi)
);

CREATE INDEX idx_prescriber_fax_pharmacy ON prescriber_fax_directory(pharmacy_id);
CREATE INDEX idx_prescriber_fax_npi ON prescriber_fax_directory(prescriber_npi);

-- Fax log - permanent record of all faxes sent through the platform
CREATE TABLE IF NOT EXISTS fax_log (
  fax_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source references
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(pharmacy_id),
  opportunity_id UUID REFERENCES opportunities(opportunity_id),
  patient_id UUID REFERENCES patients(patient_id),

  -- Prescriber target
  prescriber_name TEXT,
  prescriber_npi TEXT,
  prescriber_fax_number TEXT NOT NULL,

  -- Notifyre tracking
  notifyre_fax_id TEXT,
  fax_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (fax_status IN ('queued', 'sending', 'accepted', 'in_progress', 'successful', 'failed', 'no_answer', 'busy', 'cancelled')),
  page_count INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,

  -- Opportunity context (denormalized for analytics)
  trigger_type TEXT,
  current_drug TEXT,
  recommended_drug TEXT,

  -- Who sent it
  sent_by UUID NOT NULL REFERENCES users(user_id),
  sent_at TIMESTAMPTZ DEFAULT NOW(),

  -- NPI verification
  npi_confirmed BOOLEAN DEFAULT false,

  -- Delivery tracking
  delivered_at TIMESTAMPTZ,
  failed_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  last_status_check TIMESTAMPTZ,

  -- Webhook data
  notifyre_webhook_data JSONB,

  -- Auto-fax (future)
  is_auto_fax BOOLEAN DEFAULT false,
  auto_fax_rule TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_fax_log_pharmacy ON fax_log(pharmacy_id);
CREATE INDEX idx_fax_log_opportunity ON fax_log(opportunity_id);
CREATE INDEX idx_fax_log_prescriber_npi ON fax_log(prescriber_npi);
CREATE INDEX idx_fax_log_status ON fax_log(fax_status);
CREATE INDEX idx_fax_log_sent_at ON fax_log(sent_at DESC);
CREATE INDEX idx_fax_log_sent_by ON fax_log(sent_by);
CREATE INDEX idx_fax_log_notifyre_id ON fax_log(notifyre_fax_id);
CREATE INDEX idx_fax_log_pharmacy_date ON fax_log(pharmacy_id, sent_at DESC);

-- Composite index for prescriber cooldown checks
CREATE INDEX idx_fax_log_prescriber_cooldown
  ON fax_log(pharmacy_id, prescriber_npi, sent_at DESC)
  WHERE fax_status != 'cancelled';
