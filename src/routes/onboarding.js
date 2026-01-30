// TheRxOS V2 - Self-Service Onboarding Pipeline
// Flow: Calendly webhook → create profile → login email → upload → BAA → dashboard → agreement → Stripe → active

import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import Stripe from 'stripe';
import db from '../database/index.js';
import { authenticateToken } from './auth.js';
import { logger } from '../utils/logger.js';
import { startIngestion, getProgress } from '../services/ingest-fast-service.js';
import { runOpportunityScan } from '../services/scanner.js';

const router = express.Router();

// Stripe setup (reuse same keys as prospects.js)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// CSV upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' ||
        file.originalname.endsWith('.csv') ||
        file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Helper: get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip;
}

// =============================================
// CALENDLY WEBHOOK
// =============================================

/**
 * POST /api/onboarding/calendly-webhook
 * Receives invitee.created event from Calendly
 * Creates: client (status='new'), pharmacy, admin user
 */
router.post('/calendly-webhook', async (req, res) => {
  try {
    const event = req.body;

    // Verify Calendly webhook signature if configured
    if (process.env.CALENDLY_WEBHOOK_SECRET) {
      const signature = req.headers['calendly-webhook-signature'];
      if (!signature) {
        return res.status(401).json({ error: 'Missing webhook signature' });
      }
      // Calendly uses HMAC SHA256
      const expectedSig = crypto
        .createHmac('sha256', process.env.CALENDLY_WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      // Calendly signature format: "t=timestamp,v1=hash"
      const sigParts = signature.split(',');
      const timestamp = sigParts.find(p => p.startsWith('t='))?.slice(2);
      const v1 = sigParts.find(p => p.startsWith('v1='))?.slice(3);
      if (v1) {
        const payload = `${timestamp}.${JSON.stringify(req.body)}`;
        const computed = crypto
          .createHmac('sha256', process.env.CALENDLY_WEBHOOK_SECRET)
          .update(payload)
          .digest('hex');
        if (computed !== v1) {
          logger.warn('Invalid Calendly webhook signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }
    }

    // Only process invitee.created events
    if (event.event !== 'invitee.created') {
      return res.json({ received: true, skipped: true });
    }

    const payload = event.payload;
    const invitee = payload;
    const name = invitee.name || '';
    const email = (invitee.email || '').toLowerCase().trim();

    if (!email) {
      logger.warn('Calendly webhook missing email');
      return res.status(400).json({ error: 'Missing invitee email' });
    }

    // Check if client already exists with this email
    const existing = await db.query(
      'SELECT client_id FROM clients WHERE submitter_email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      logger.info('Calendly webhook: client already exists', { email });
      return res.json({ received: true, existing: true, clientId: existing.rows[0].client_id });
    }

    // Extract custom questions from Calendly payload
    // Calendly sends custom question answers in questions_and_answers array
    const qAndA = invitee.questions_and_answers || [];
    let pharmacyName = '';
    let pharmacyNpi = '';
    let pharmacyState = '';
    let pmsSystem = '';
    let phone = invitee.text_reminder_number || '';

    for (const qa of qAndA) {
      const q = (qa.question || '').toLowerCase();
      const a = (qa.answer || '').trim();
      if (q.includes('pharmacy name') || q.includes('business name')) {
        pharmacyName = a;
      } else if (q.includes('npi')) {
        pharmacyNpi = a;
      } else if (q.includes('state')) {
        pharmacyState = a;
      } else if (q.includes('pms') || q.includes('software') || q.includes('system')) {
        pmsSystem = a;
      } else if (q.includes('phone') && !phone) {
        phone = a;
      }
    }

    // Fallback pharmacy name to invitee name
    if (!pharmacyName) {
      pharmacyName = name || email.split('@')[0];
    }

    // Parse first/last name
    const nameParts = name.split(' ').filter(Boolean);
    const firstName = nameParts[0] || email.split('@')[0];
    const lastName = nameParts.slice(1).join(' ') || '';

    // Create client
    const clientId = uuidv4();
    const pharmacyId = uuidv4();
    const subdomain = pharmacyName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);

    await db.query(`
      INSERT INTO clients (
        client_id, client_name, dashboard_subdomain, submitter_email, status,
        primary_contact_name, primary_contact_phone,
        primary_contact_first_name, primary_contact_last_name,
        calendly_event_uri, calendly_invitee_uri,
        login_email_sent, login_email_scheduled_at,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9, $10, false, NOW() + INTERVAL '1 hour', NOW(), NOW())
    `, [
      clientId, pharmacyName, subdomain, email,
      name, phone,
      firstName, lastName,
      payload.event || null,
      payload.uri || null
    ]);

    // Create pharmacy with auto-generated upload API key
    const uploadApiKey = crypto.randomBytes(32).toString('hex');
    await db.query(`
      INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, state, pms_system, upload_api_key, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [pharmacyId, clientId, pharmacyName, pharmacyNpi || 'PENDING', pharmacyState || 'XX', pmsSystem || 'pending', uploadApiKey]);

    // Create admin user with firstname1234 password
    const userId = uuidv4();
    const password = `${firstName.toLowerCase()}1234`;
    const passwordHash = await bcrypt.hash(password, 12);

    await db.query(`
      INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active, must_change_password, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', true, false, NOW())
    `, [userId, clientId, pharmacyId, email, passwordHash, firstName, lastName || 'Admin']);

    logger.info('Calendly onboarding: client created', {
      clientId, pharmacyId, userId, email, pharmacyName, status: 'new'
    });

    res.json({
      received: true,
      clientId,
      pharmacyId,
      userId,
      email,
      pharmacyName,
      status: 'new'
    });
  } catch (error) {
    logger.error('Calendly webhook error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});


// =============================================
// ONBOARDING STATUS
// =============================================

/**
 * GET /api/onboarding/status
 * Returns current onboarding progress for authenticated client
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.client_id, c.client_name, c.status as client_status,
        c.baa_accepted_at, c.agreement_signed_at, c.stripe_payment_at,
        c.onboarding_completed_at, c.stripe_customer_id,
        (SELECT COUNT(*) FROM prescriptions WHERE pharmacy_id = p.pharmacy_id) as prescription_count,
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = p.pharmacy_id) as patient_count,
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = p.pharmacy_id AND status = 'Not Submitted') as opportunity_count,
        p.pharmacy_id, p.pharmacy_name
      FROM clients c
      JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
      LIMIT 1
    `, [req.user.clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];

    res.json({
      clientId: client.client_id,
      clientName: client.client_name,
      pharmacyId: client.pharmacy_id,
      pharmacyName: client.pharmacy_name,
      clientStatus: client.client_status,
      steps: {
        baaAccepted: !!client.baa_accepted_at,
        baaAcceptedAt: client.baa_accepted_at,
        dataUploaded: parseInt(client.prescription_count) > 0,
        patientCount: parseInt(client.patient_count),
        prescriptionCount: parseInt(client.prescription_count),
        opportunityCount: parseInt(client.opportunity_count),
        agreementSigned: !!client.agreement_signed_at,
        agreementSignedAt: client.agreement_signed_at,
        paymentComplete: !!client.stripe_payment_at,
        paymentAt: client.stripe_payment_at,
        onboardingComplete: !!client.onboarding_completed_at,
      }
    });
  } catch (error) {
    logger.error('Onboarding status error', { error: error.message });
    res.status(500).json({ error: 'Failed to get onboarding status' });
  }
});


// =============================================
// BAA
// =============================================

/**
 * GET /api/onboarding/baa
 * Returns BAA content from baa_templates table
 */
router.get('/baa', authenticateToken, async (req, res) => {
  try {
    const baaResult = await db.query(`
      SELECT template_id, version, title, content, effective_date
      FROM baa_templates
      WHERE is_active = true
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (baaResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active BAA template found' });
    }

    const baa = baaResult.rows[0];

    // Check if already accepted
    const clientResult = await db.query(
      'SELECT baa_accepted_at FROM clients WHERE client_id = $1',
      [req.user.clientId]
    );

    res.json({
      templateId: baa.template_id,
      version: baa.version,
      title: baa.title,
      content: baa.content,
      effectiveDate: baa.effective_date,
      alreadyAccepted: !!clientResult.rows[0]?.baa_accepted_at,
      acceptedAt: clientResult.rows[0]?.baa_accepted_at || null,
    });
  } catch (error) {
    logger.error('Get BAA error', { error: error.message });
    res.status(500).json({ error: 'Failed to get BAA' });
  }
});

/**
 * POST /api/onboarding/accept-baa
 * Records BAA acceptance
 */
router.post('/accept-baa', authenticateToken, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const ip = getClientIP(req);

    // Check current status
    const check = await db.query(
      'SELECT status, baa_accepted_at FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (check.rows[0].baa_accepted_at) {
      return res.json({ success: true, message: 'BAA already accepted', acceptedAt: check.rows[0].baa_accepted_at });
    }

    await db.query(`
      UPDATE clients SET
        baa_accepted_at = NOW(),
        baa_accepted_ip = $1,
        updated_at = NOW()
      WHERE client_id = $2
    `, [ip, clientId]);

    logger.info('BAA accepted', { clientId, ip });

    res.json({ success: true, message: 'BAA accepted', acceptedAt: new Date().toISOString() });
  } catch (error) {
    logger.error('Accept BAA error', { error: error.message });
    res.status(500).json({ error: 'Failed to accept BAA' });
  }
});


// =============================================
// DATA UPLOAD & INGESTION
// =============================================

/**
 * POST /api/onboarding/upload
 * Upload CSV for fast ingestion (new/onboarding clients)
 * Requires BAA to be accepted first
 */
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const clientId = req.user.clientId;
    const pharmacyId = req.user.pharmacyId;

    // Verify client status allows upload
    const client = await db.query(
      'SELECT status, baa_accepted_at FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (client.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { status, baa_accepted_at } = client.rows[0];

    if (!['new', 'onboarding'].includes(status)) {
      // Active clients can still upload via the regular upload endpoint
      if (status === 'active') {
        return res.status(400).json({ error: 'Active clients should use the regular upload endpoint' });
      }
      return res.status(403).json({ error: 'Upload not available for current account status' });
    }

    if (!baa_accepted_at) {
      return res.status(403).json({ error: 'BAA must be accepted before uploading data' });
    }

    // Start async ingestion with progress tracking
    const csvContent = req.file.buffer.toString('utf-8');
    const jobId = startIngestion(pharmacyId, csvContent);

    logger.info('Onboarding upload started', { clientId, pharmacyId, jobId, fileSize: req.file.size });

    res.json({
      success: true,
      jobId,
      message: 'Ingestion started. Poll /api/onboarding/upload-progress/:jobId for updates.'
    });
  } catch (error) {
    logger.error('Onboarding upload error', { error: error.message });
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * GET /api/onboarding/upload-progress/:jobId
 * Poll ingestion progress
 */
router.get('/upload-progress/:jobId', authenticateToken, async (req, res) => {
  try {
    const progress = getProgress(req.params.jobId);

    if (!progress) {
      return res.status(404).json({ error: 'Job not found or expired' });
    }

    const response = {
      jobId: req.params.jobId,
      status: progress.status,
      phase: progress.phase,
      current: progress.current,
      total: progress.total,
      error: progress.error,
    };

    // If complete, include result and transition client status
    if (progress.status === 'complete' && progress.result) {
      response.result = progress.result;

      // Transition client to 'onboarding' if still 'new'
      const clientResult = await db.query(
        'SELECT status FROM clients WHERE client_id = $1',
        [req.user.clientId]
      );
      if (clientResult.rows[0]?.status === 'new') {
        await db.query(
          "UPDATE clients SET status = 'onboarding', updated_at = NOW() WHERE client_id = $1",
          [req.user.clientId]
        );
        response.statusTransition = 'onboarding';
        logger.info('Client transitioned to onboarding', { clientId: req.user.clientId });

        // Trigger scanner in background
        try {
          runOpportunityScan({ pharmacyIds: [req.user.pharmacyId], scanType: 'onboarding_upload' })
            .then(result => {
              logger.info('Onboarding scan complete', { pharmacyId: req.user.pharmacyId, opportunities: result?.opportunitiesFound });
            })
            .catch(err => {
              logger.error('Onboarding scan failed', { error: err.message });
            });
        } catch (scanErr) {
          logger.error('Failed to start onboarding scan', { error: scanErr.message });
        }
      }
    }

    res.json(response);
  } catch (error) {
    logger.error('Upload progress error', { error: error.message });
    res.status(500).json({ error: 'Failed to get progress' });
  }
});


// =============================================
// SERVICE AGREEMENT
// =============================================

/**
 * GET /api/onboarding/agreement
 * Returns service agreement content (HTML)
 */
router.get('/agreement', authenticateToken, async (req, res) => {
  try {
    const clientResult = await db.query(`
      SELECT c.client_name, c.submitter_email, c.status, c.agreement_signed_at,
             p.pharmacy_name, p.pharmacy_npi, p.state, p.address, p.city, p.zip
      FROM clients c
      JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
      LIMIT 1
    `, [req.user.clientId]);

    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = clientResult.rows[0];

    // Build agreement content (inline HTML — the ServiceAgreement.docx is for attached docs)
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const agreementHtml = `
<h2>TheRxOS Service Agreement</h2>
<p><strong>Effective Date:</strong> ${today}</p>
<p><strong>Between:</strong> TheRxOS LLC ("Provider") and ${client.pharmacy_name || client.client_name} ("Client")</p>

<h3>1. Services</h3>
<p>Provider agrees to provide Client with access to TheRxOS platform, including:</p>
<ul>
  <li>Clinical opportunity identification and tracking</li>
  <li>Prescription data analysis and reporting</li>
  <li>Insurance coverage intelligence</li>
  <li>Prescriber communication tools</li>
  <li>Dashboard analytics and monthly reports</li>
</ul>

<h3>2. Subscription</h3>
<p>Client agrees to pay $599 per month per pharmacy location for access to the TheRxOS platform. Billing begins upon activation of the account.</p>

<h3>3. Data Handling</h3>
<p>Provider will handle all pharmacy data in compliance with HIPAA regulations as outlined in the Business Associate Agreement (BAA) separately executed between the parties.</p>

<h3>4. Term</h3>
<p>This agreement is effective from the date of signing and continues on a month-to-month basis. Either party may cancel with 30 days written notice.</p>

<h3>5. Confidentiality</h3>
<p>Both parties agree to maintain the confidentiality of all proprietary information shared during the course of this agreement.</p>

<h3>6. Limitation of Liability</h3>
<p>Provider's liability shall not exceed the total fees paid by Client in the 12 months preceding any claim. Provider is not liable for clinical decisions made based on platform data.</p>

<h3>7. Acceptance</h3>
<p>By signing below, Client agrees to the terms of this Service Agreement.</p>
    `.trim();

    res.json({
      content: agreementHtml,
      pharmacyName: client.pharmacy_name,
      email: client.submitter_email,
      alreadySigned: !!client.agreement_signed_at,
      signedAt: client.agreement_signed_at || null,
    });
  } catch (error) {
    logger.error('Get agreement error', { error: error.message });
    res.status(500).json({ error: 'Failed to get agreement' });
  }
});

/**
 * POST /api/onboarding/sign-agreement
 * Records service agreement signature
 */
router.post('/sign-agreement', authenticateToken, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { signerName } = req.body;
    const ip = getClientIP(req);

    if (!signerName) {
      return res.status(400).json({ error: 'Signer name is required' });
    }

    // Check current status
    const check = await db.query(
      'SELECT status, agreement_signed_at, stripe_payment_at FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (check.rows[0].agreement_signed_at) {
      return res.json({ success: true, message: 'Agreement already signed', signedAt: check.rows[0].agreement_signed_at });
    }

    // Record signature
    await db.query(`
      UPDATE clients SET
        agreement_signed_at = NOW(),
        agreement_signed_ip = $1,
        agreement_signer_name = $2,
        updated_at = NOW()
      WHERE client_id = $3
    `, [ip, signerName, clientId]);

    logger.info('Agreement signed', { clientId, signerName, ip });

    // Check if both agreement signed + paid → auto-activate
    let newStatus = null;
    if (check.rows[0].stripe_payment_at) {
      await db.query(`
        UPDATE clients SET
          status = 'active',
          onboarding_completed_at = NOW(),
          updated_at = NOW()
        WHERE client_id = $1
      `, [clientId]);
      newStatus = 'active';
      logger.info('Client auto-activated (agreement signed, already paid)', { clientId });
    }

    res.json({
      success: true,
      message: 'Agreement signed',
      signedAt: new Date().toISOString(),
      newStatus,
    });
  } catch (error) {
    logger.error('Sign agreement error', { error: error.message });
    res.status(500).json({ error: 'Failed to sign agreement' });
  }
});


// =============================================
// STRIPE CHECKOUT
// =============================================

/**
 * POST /api/onboarding/create-checkout
 * Creates Stripe checkout session for onboarding client
 */
router.post('/create-checkout', authenticateToken, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const clientId = req.user.clientId;
    const pharmacyId = req.user.pharmacyId;

    // Get client info
    const clientResult = await db.query(
      'SELECT client_name, submitter_email, stripe_payment_at FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = clientResult.rows[0];

    if (client.stripe_payment_at) {
      return res.json({ success: true, message: 'Already paid', alreadyPaid: true });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: client.submitter_email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: {
        clientId,
        pharmacyId,
        source: 'onboarding_pipeline',
      },
      success_url: `${frontendUrl}/dashboard?onboarding=payment_success`,
      cancel_url: `${frontendUrl}/dashboard?onboarding=payment_cancelled`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    logger.error('Onboarding checkout error', { error: error.message });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/onboarding/stripe-webhook
 * Handles Stripe payment confirmation for onboarding
 */
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { clientId, source } = session.metadata;

      // Only process onboarding pipeline payments
      if (source !== 'onboarding_pipeline' || !clientId) {
        return res.json({ received: true, skipped: true });
      }

      // Record payment
      await db.query(`
        UPDATE clients SET
          stripe_payment_at = NOW(),
          stripe_customer_id = $1,
          updated_at = NOW()
        WHERE client_id = $2
      `, [session.customer, clientId]);

      logger.info('Onboarding payment received', { clientId, customerId: session.customer });

      // Check if agreement already signed → auto-activate
      const check = await db.query(
        'SELECT agreement_signed_at FROM clients WHERE client_id = $1',
        [clientId]
      );

      if (check.rows[0]?.agreement_signed_at) {
        await db.query(`
          UPDATE clients SET
            status = 'active',
            onboarding_completed_at = NOW(),
            updated_at = NOW()
          WHERE client_id = $1
        `, [clientId]);
        logger.info('Client auto-activated (paid, agreement already signed)', { clientId });
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Onboarding Stripe webhook error', { error: error.message });
    res.status(400).json({ error: 'Webhook failed' });
  }
});


export default router;
