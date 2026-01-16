-- Migration: 006_secure_uploads.sql
-- HIPAA-Compliant Secure Upload Portal for TheRxOS V2
-- Allows prospects to upload PHI data securely before formal onboarding
-- Run this in Supabase SQL Editor

-- ===========================================
-- SECURE UPLOADS TABLE
-- Tracks upload sessions/links for prospects
-- ===========================================
CREATE TABLE IF NOT EXISTS secure_uploads (
  upload_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token VARCHAR(64) UNIQUE NOT NULL,  -- Cryptographically secure random token

  -- Prospect info
  pharmacy_name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(20),
  notes TEXT,  -- Admin notes about this prospect

  -- Security
  encryption_key_id VARCHAR(100),  -- Reference to encryption key version
  baa_accepted BOOLEAN DEFAULT false,
  baa_accepted_at TIMESTAMPTZ,
  baa_accepted_ip VARCHAR(45),
  baa_signer_name VARCHAR(255),

  -- Upload status
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
    'pending',      -- Link created, awaiting upload
    'uploaded',     -- Files uploaded, awaiting processing
    'processing',   -- Files being processed/ingested
    'completed',    -- Successfully onboarded
    'expired',      -- Link expired, files deleted
    'deleted'       -- Manually deleted
  )),
  file_count INTEGER DEFAULT 0,
  total_size_bytes BIGINT DEFAULT 0,

  -- Retention
  expires_at TIMESTAMPTZ NOT NULL,
  auto_delete_days INTEGER DEFAULT 30,

  -- Audit trail
  created_by UUID REFERENCES users(user_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,

  -- Onboarding link
  onboarded_client_id UUID REFERENCES clients(client_id),
  onboarded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_secure_uploads_token ON secure_uploads(access_token);
CREATE INDEX IF NOT EXISTS idx_secure_uploads_status ON secure_uploads(status);
CREATE INDEX IF NOT EXISTS idx_secure_uploads_expires ON secure_uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_secure_uploads_email ON secure_uploads(contact_email);


-- ===========================================
-- SECURE UPLOAD FILES TABLE
-- Tracks individual files uploaded
-- ===========================================
CREATE TABLE IF NOT EXISTS secure_upload_files (
  file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES secure_uploads(upload_id) ON DELETE CASCADE,

  -- File info
  original_filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,  -- Randomized name for storage
  file_size_bytes BIGINT NOT NULL,
  mime_type VARCHAR(100),
  checksum_sha256 VARCHAR(64),

  -- Encryption
  encrypted BOOLEAN DEFAULT true,
  encryption_iv VARCHAR(32),  -- Initialization vector (hex)
  encryption_tag VARCHAR(32),  -- Auth tag for GCM mode (hex)

  -- Metadata
  file_type VARCHAR(50),  -- csv, xlsx, pdf, etc.
  row_count INTEGER,  -- For CSV files, estimated row count
  column_count INTEGER,

  -- Timestamps
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ  -- Soft delete
);

CREATE INDEX IF NOT EXISTS idx_secure_upload_files_upload ON secure_upload_files(upload_id);
CREATE INDEX IF NOT EXISTS idx_secure_upload_files_deleted ON secure_upload_files(deleted_at) WHERE deleted_at IS NULL;


-- ===========================================
-- SECURE UPLOAD AUDIT LOG
-- Tracks all actions for HIPAA compliance
-- ===========================================
CREATE TABLE IF NOT EXISTS secure_upload_audit_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES secure_uploads(upload_id) ON DELETE SET NULL,

  -- Event info
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'created',           -- Upload link created
    'accessed',          -- Link accessed (viewed)
    'baa_accepted',      -- BAA checkbox accepted
    'file_uploaded',     -- File uploaded
    'file_deleted',      -- File deleted by prospect
    'downloaded',        -- File downloaded by admin
    'status_changed',    -- Status updated
    'extended',          -- Expiration extended
    'expired',           -- Auto-expired by system
    'deleted',           -- Manually deleted
    'onboarded'          -- Successfully onboarded as client
  )),
  event_details JSONB,

  -- Actor info
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('admin', 'prospect', 'system')),
  actor_id UUID,  -- user_id for admins, NULL for prospects/system
  actor_email VARCHAR(255),  -- For tracking prospect actions
  actor_ip VARCHAR(45),
  user_agent TEXT,

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secure_upload_audit_upload ON secure_upload_audit_log(upload_id);
CREATE INDEX IF NOT EXISTS idx_secure_upload_audit_event ON secure_upload_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_secure_upload_audit_date ON secure_upload_audit_log(created_at DESC);


-- ===========================================
-- BAA TEMPLATE TABLE
-- Stores BAA text versions for compliance tracking
-- ===========================================
CREATE TABLE IF NOT EXISTS baa_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version VARCHAR(20) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL DEFAULT 'Business Associate Agreement',
  content TEXT NOT NULL,
  effective_date DATE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default BAA template
INSERT INTO baa_templates (version, title, content, effective_date, is_active)
VALUES (
  '1.0',
  'Business Associate Agreement',
  E'BUSINESS ASSOCIATE AGREEMENT\n\nThis Business Associate Agreement ("Agreement") is entered into by and between the pharmacy uploading data ("Covered Entity") and TheRxOS, LLC ("Business Associate").\n\n1. DEFINITIONS\n\nTerms used but not otherwise defined in this Agreement shall have the same meaning as those terms in the HIPAA Rules.\n\n2. OBLIGATIONS OF BUSINESS ASSOCIATE\n\nBusiness Associate agrees to:\n\na) Not use or disclose Protected Health Information (PHI) other than as permitted or required by this Agreement or as Required by Law;\n\nb) Use appropriate safeguards to prevent use or disclosure of PHI other than as provided for by this Agreement;\n\nc) Report to Covered Entity any use or disclosure of PHI not provided for by this Agreement of which it becomes aware;\n\nd) Ensure that any agents or subcontractors agree to the same restrictions;\n\ne) Make available PHI to Covered Entity as required;\n\nf) Make its internal practices available for inspection by HHS;\n\ng) Return or destroy all PHI upon termination.\n\n3. PERMITTED USES AND DISCLOSURES\n\nBusiness Associate may use or disclose PHI as necessary to perform services for Covered Entity, including but not limited to:\n\na) Analysis of prescription data for clinical opportunity identification;\n\nb) Generation of reports and recommendations;\n\nc) Data storage and processing.\n\n4. TERM AND TERMINATION\n\nThis Agreement shall be effective upon acceptance and shall terminate when all PHI is destroyed or returned.\n\n5. SECURITY\n\nBusiness Associate maintains HIPAA-compliant security measures including:\n\na) AES-256 encryption for data at rest;\n\nb) TLS 1.3 encryption for data in transit;\n\nc) Access controls and audit logging;\n\nd) Automatic data retention and deletion policies.\n\nBy checking the acceptance box, you acknowledge that you have read, understand, and agree to be bound by the terms of this Business Associate Agreement.',
  CURRENT_DATE,
  true
) ON CONFLICT (version) DO NOTHING;


-- ===========================================
-- HELPER FUNCTIONS
-- ===========================================

-- Function to generate secure random token
CREATE OR REPLACE FUNCTION generate_secure_token(length INTEGER DEFAULT 64)
RETURNS VARCHAR
LANGUAGE plpgsql
AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  result VARCHAR := '';
  i INTEGER;
BEGIN
  FOR i IN 1..length LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::INTEGER, 1);
  END LOOP;
  RETURN result;
END;
$$;


-- Function to create upload link with auto-token
CREATE OR REPLACE FUNCTION create_secure_upload(
  p_pharmacy_name VARCHAR,
  p_contact_email VARCHAR,
  p_created_by UUID,
  p_expires_days INTEGER DEFAULT 30,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  upload_id UUID,
  access_token VARCHAR,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_upload_id UUID;
  v_token VARCHAR;
  v_expires TIMESTAMPTZ;
BEGIN
  v_upload_id := gen_random_uuid();
  v_token := generate_secure_token(64);
  v_expires := NOW() + (p_expires_days || ' days')::INTERVAL;

  INSERT INTO secure_uploads (
    upload_id, access_token, pharmacy_name, contact_email,
    notes, created_by, expires_at, auto_delete_days
  ) VALUES (
    v_upload_id, v_token, p_pharmacy_name, p_contact_email,
    p_notes, p_created_by, v_expires, p_expires_days
  );

  -- Log the creation
  INSERT INTO secure_upload_audit_log (
    upload_id, event_type, actor_type, actor_id, event_details
  ) VALUES (
    v_upload_id, 'created', 'admin', p_created_by,
    jsonb_build_object(
      'pharmacy_name', p_pharmacy_name,
      'contact_email', p_contact_email,
      'expires_days', p_expires_days
    )
  );

  RETURN QUERY SELECT v_upload_id, v_token, v_expires;
END;
$$;


-- Function to log upload access
CREATE OR REPLACE FUNCTION log_upload_access(
  p_upload_id UUID,
  p_ip VARCHAR,
  p_user_agent TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Update access tracking
  UPDATE secure_uploads
  SET last_accessed_at = NOW(),
      access_count = access_count + 1
  WHERE upload_id = p_upload_id;

  -- Log the access
  INSERT INTO secure_upload_audit_log (
    upload_id, event_type, actor_type, actor_ip, user_agent
  ) VALUES (
    p_upload_id, 'accessed', 'prospect', p_ip, p_user_agent
  );
END;
$$;


-- Function to accept BAA
CREATE OR REPLACE FUNCTION accept_baa(
  p_upload_id UUID,
  p_signer_name VARCHAR,
  p_ip VARCHAR,
  p_user_agent TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE secure_uploads
  SET baa_accepted = true,
      baa_accepted_at = NOW(),
      baa_accepted_ip = p_ip,
      baa_signer_name = p_signer_name
  WHERE upload_id = p_upload_id
    AND baa_accepted = false;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Log the BAA acceptance
  INSERT INTO secure_upload_audit_log (
    upload_id, event_type, actor_type, actor_ip, user_agent, event_details
  ) VALUES (
    p_upload_id, 'baa_accepted', 'prospect', p_ip, p_user_agent,
    jsonb_build_object('signer_name', p_signer_name)
  );

  RETURN true;
END;
$$;


-- Function to cleanup expired uploads
CREATE OR REPLACE FUNCTION cleanup_expired_uploads()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  -- Mark expired uploads
  UPDATE secure_uploads
  SET status = 'expired'
  WHERE status IN ('pending', 'uploaded')
    AND expires_at < NOW();

  GET DIAGNOSTICS expired_count = ROW_COUNT;

  -- Log expirations
  INSERT INTO secure_upload_audit_log (upload_id, event_type, actor_type)
  SELECT upload_id, 'expired', 'system'
  FROM secure_uploads
  WHERE status = 'expired'
    AND upload_id NOT IN (
      SELECT DISTINCT upload_id FROM secure_upload_audit_log WHERE event_type = 'expired'
    );

  RETURN expired_count;
END;
$$;


-- ===========================================
-- VIEWS
-- ===========================================

-- View for active uploads (admin dashboard)
CREATE OR REPLACE VIEW v_active_uploads AS
SELECT
  su.upload_id,
  su.access_token,
  su.pharmacy_name,
  su.contact_email,
  su.status,
  su.baa_accepted,
  su.file_count,
  su.total_size_bytes,
  su.expires_at,
  su.created_at,
  su.last_accessed_at,
  su.access_count,
  u.email as created_by_email,
  CASE
    WHEN su.expires_at < NOW() THEN 'expired'
    WHEN su.expires_at < NOW() + INTERVAL '3 days' THEN 'expiring_soon'
    ELSE 'active'
  END as expiry_status
FROM secure_uploads su
LEFT JOIN users u ON u.user_id = su.created_by
WHERE su.status NOT IN ('deleted', 'expired')
ORDER BY su.created_at DESC;


-- View for upload audit trail
CREATE OR REPLACE VIEW v_upload_audit_trail AS
SELECT
  sal.log_id,
  sal.upload_id,
  su.pharmacy_name,
  sal.event_type,
  sal.event_details,
  sal.actor_type,
  COALESCE(u.email, sal.actor_email, 'System') as actor_email,
  sal.actor_ip,
  sal.created_at
FROM secure_upload_audit_log sal
LEFT JOIN secure_uploads su ON su.upload_id = sal.upload_id
LEFT JOIN users u ON u.user_id = sal.actor_id
ORDER BY sal.created_at DESC;


-- ===========================================
-- ROW LEVEL SECURITY (Optional)
-- ===========================================

-- Enable RLS if needed
-- ALTER TABLE secure_uploads ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE secure_upload_files ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE secure_upload_audit_log ENABLE ROW LEVEL SECURITY;


-- ===========================================
-- GRANTS
-- ===========================================
GRANT ALL ON secure_uploads TO authenticated;
GRANT ALL ON secure_upload_files TO authenticated;
GRANT ALL ON secure_upload_audit_log TO authenticated;
GRANT ALL ON baa_templates TO authenticated;
GRANT EXECUTE ON FUNCTION generate_secure_token TO authenticated;
GRANT EXECUTE ON FUNCTION create_secure_upload TO authenticated;
GRANT EXECUTE ON FUNCTION log_upload_access TO authenticated;
GRANT EXECUTE ON FUNCTION accept_baa TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_expired_uploads TO authenticated;


-- Success message
DO $$ BEGIN RAISE NOTICE 'Secure upload tables created successfully!'; END $$;
