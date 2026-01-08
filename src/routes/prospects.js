// prospects.js - API routes for prospect data analysis and checkout
// Handles: file upload, opportunity analysis, Stripe checkout

import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { v4 as uuidv4 } from 'uuid';
import Stripe from 'stripe';
import db from '../database/index.js';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.originalname.endsWith('.csv') ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

// Initialize Stripe (add STRIPE_SECRET_KEY to .env)
const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Store analyses in memory for now (could move to DB later)
const analysisCache = new Map();

// Trigger definitions (simplified version for quick analysis)
const QUICK_TRIGGERS = [
  {
    id: 'ppi_switch',
    name: 'PPI to Dexlansoprazole',
    type: 'therapeutic_interchange',
    detect: ['OMEPRAZOLE', 'PANTOPRAZOLE', 'ESOMEPRAZOLE', 'LANSOPRAZOLE'],
    exclude: ['DEXLANSOPRAZOLE'],
    value: 79,
  },
  {
    id: 'missing_pen_needles',
    name: 'Missing Pen Needles',
    type: 'missing_therapy',
    detect: ['LANTUS', 'HUMALOG', 'NOVOLOG', 'BASAGLAR', 'TRESIBA', 'LEVEMIR'],
    requireMissing: ['PEN NEEDLE', 'NDL'],
    value: 93,
  },
  {
    id: 'missing_lancets',
    name: 'Missing Lancets',
    type: 'missing_therapy',
    detect: ['TEST STRIP', 'GLUCOSE', 'ACCU-CHEK', 'ONETOUCH', 'FREESTYLE'],
    requireMissing: ['LANCET'],
    value: 90,
  },
  {
    id: 'needle_conversion',
    name: 'Pen Needle NDC Optimization',
    type: 'ndc_optimization',
    detect: ['BD NANO', 'EASY COMFORT PEN', 'UNIFINE', 'PEN NEEDLE'],
    exclude: ['COMFORT EZ'],
    value: 93,
  },
  {
    id: 'lancet_conversion',
    name: 'Lancet NDC Optimization',
    type: 'ndc_optimization',
    detect: ['LANCET', 'SOFTCLIX'],
    exclude: ['PURE COMFORT', 'SAFETY LANCET'],
    value: 90,
  },
  {
    id: 'missing_bp_monitor',
    name: 'Missing BP Monitor',
    type: 'missing_therapy',
    detect: ['LISINOPRIL', 'AMLODIPINE', 'LOSARTAN', 'METOPROLOL', 'ATENOLOL', 'HYDROCHLOROTHIAZIDE'],
    requireMissing: ['BP MONITOR', 'BLOOD PRESSURE'],
    value: 121,
  },
  {
    id: 'inhaler_spacer',
    name: 'Missing Inhaler Spacer',
    type: 'missing_therapy',
    detect: ['ALBUTEROL', 'VENTOLIN', 'PROAIR', 'SYMBICORT', 'ADVAIR', 'BREO'],
    requireMissing: ['SPACER', 'CHAMBER'],
    value: 98,
  },
  {
    id: 'glp1_antinausea',
    name: 'GLP-1 Missing Anti-Nausea',
    type: 'missing_therapy',
    detect: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'TRULICITY', 'VICTOZA', 'SAXENDA'],
    requireMissing: ['ONDANSETRON', 'ZOFRAN', 'PROMETHAZINE'],
    value: 45,
  },
];

// Column mapping for common PMS exports
const COLUMN_ALIASES = {
  patient_name: ['Patient Full Name Last then First', 'Patient Name', 'PatientName', 'Patient', 'Name', 'Member Name', 'Member'],
  drug_name: [
    'Dispensed Item Name', 'Drug Name', 'DrugName', 'Medication', 'Drug',
    'Product Name', 'ProductName', 'Item Name', 'Rx Name', 'Med Name',
    'Description', 'Drug Description', 'Item Description', 'Product',
    'Medication Name', 'Prescription', 'Dispensed Drug', 'Label Name'
  ],
  ndc: ['Dispensed Item NDC', 'NDC', 'NDC11', 'NDC Code', 'National Drug Code'],
  insurance_bin: ['Primary Third Party Bin', 'BIN', 'Bin', 'Insurance BIN', 'Payer BIN'],
  insurance_group: ['Primary Group Number', 'Group', 'Group Number', 'Insurance Group', 'Group ID'],
  fill_date: ['Date Written', 'Fill Date', 'Dispensed Date', 'Date', 'Date Filled', 'Service Date', 'DOS'],
  dob: ['Patient Date of Birth', 'DOB', 'Date of Birth', 'Patient DOB', 'Birth Date', 'Birthdate'],
};

function findColumn(headers, aliases) {
  // First try exact match (case-insensitive)
  for (const alias of aliases) {
    const found = headers.find(h => h.toLowerCase() === alias.toLowerCase());
    if (found) return found;
  }
  // Then try contains match for flexibility
  for (const alias of aliases) {
    const found = headers.find(h =>
      h.toLowerCase().includes(alias.toLowerCase()) ||
      alias.toLowerCase().includes(h.toLowerCase())
    );
    if (found) return found;
  }
  return null;
}

function parseCSV(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.split('\n');
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    delimiter,
  });
}

// POST /api/prospects/analyze - Upload and analyze prescription data
router.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    const { email, pharmacyName } = req.body;
    const file = req.file;

    if (!file || !email || !pharmacyName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Parse CSV
    const records = parseCSV(file.buffer);
    const headers = Object.keys(records[0] || {});

    // Map columns
    const patientCol = findColumn(headers, COLUMN_ALIASES.patient_name);
    const drugCol = findColumn(headers, COLUMN_ALIASES.drug_name);
    const binCol = findColumn(headers, COLUMN_ALIASES.insurance_bin);
    const groupCol = findColumn(headers, COLUMN_ALIASES.insurance_group);
    const dobCol = findColumn(headers, COLUMN_ALIASES.dob);

    // Drug column is required, but patient column is optional for prospect preview
    if (!drugCol) {
      return res.status(400).json({
        error: 'Could not identify drug/medication column. Please ensure your export includes drug names.'
      });
    }

    // Build patient profiles
    const patients = new Map();
    const allUniqueDrugs = new Set(); // Track all unique drugs for no-patient mode

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const drugName = (row[drugCol] || '').toUpperCase().trim();

      if (!drugName) continue;

      allUniqueDrugs.add(drugName);

      if (patientCol) {
        // If we have patient column, group by patient
        const patientName = row[patientCol]?.trim();
        if (!patientName) continue;

        const dob = dobCol ? row[dobCol] : '';
        const patientKey = `${patientName}|${dob}`;

        if (!patients.has(patientKey)) {
          patients.set(patientKey, {
            name: patientName,
            dob,
            bin: binCol ? row[binCol] : null,
            group: groupCol ? row[groupCol] : null,
            drugs: new Set(),
          });
        }

        patients.get(patientKey).drugs.add(drugName);
      }
    }

    // Run opportunity detection
    const opportunities = [];
    const byType = {};

    if (patientCol && patients.size > 0) {
      // ACCURATE MODE: We have patient data, analyze per-patient
      for (const [patientKey, patient] of patients) {
        const drugList = Array.from(patient.drugs);
        const drugString = drugList.join(' ');

        for (const trigger of QUICK_TRIGGERS) {
          const hasDetect = trigger.detect.some(keyword =>
            drugString.includes(keyword.toUpperCase())
          );

          if (!hasDetect) continue;

          if (trigger.exclude) {
            const hasExclude = trigger.exclude.some(keyword =>
              drugString.includes(keyword.toUpperCase())
            );
            if (hasExclude) continue;
          }

          if (trigger.requireMissing) {
            const hasMissing = trigger.requireMissing.some(keyword =>
              drugString.includes(keyword.toUpperCase())
            );
            if (hasMissing) continue;
          }

          opportunities.push({
            patientKey,
            triggerId: trigger.id,
            type: trigger.type,
            value: trigger.value,
          });

          if (!byType[trigger.type]) {
            byType[trigger.type] = { count: 0, annualValue: 0 };
          }
          byType[trigger.type].count++;
          byType[trigger.type].annualValue += trigger.value * 12;
        }
      }
    } else {
      // ESTIMATE MODE: No patient data - count unique drugs matching each trigger
      const allDrugsString = Array.from(allUniqueDrugs).join(' ');

      for (const trigger of QUICK_TRIGGERS) {
        // Count unique drugs that match this trigger's detection keywords
        let matchCount = 0;
        for (const drug of allUniqueDrugs) {
          const matches = trigger.detect.some(keyword =>
            drug.includes(keyword.toUpperCase())
          );
          if (matches) {
            // Check exclusions
            if (trigger.exclude) {
              const excluded = trigger.exclude.some(keyword =>
                drug.includes(keyword.toUpperCase())
              );
              if (excluded) continue;
            }
            matchCount++;
          }
        }

        if (matchCount === 0) continue;

        // For missing therapy triggers without patient data, estimate ~70% might be missing
        // For other triggers, use the match count directly
        let estimatedCount = matchCount;
        if (trigger.requireMissing) {
          estimatedCount = Math.ceil(matchCount * 0.7);
        }

        if (estimatedCount > 0) {
          opportunities.push({
            patientKey: 'estimate',
            triggerId: trigger.id,
            type: trigger.type,
            value: trigger.value,
            count: estimatedCount,
          });

          if (!byType[trigger.type]) {
            byType[trigger.type] = { count: 0, annualValue: 0 };
          }
          byType[trigger.type].count += estimatedCount;
          byType[trigger.type].annualValue += trigger.value * 12 * estimatedCount;
        }
      }
    }

    // Calculate totals (handle both accurate and estimate modes)
    const totalOpportunities = Object.values(byType).reduce((sum, t) => sum + t.count, 0);
    const totalAnnualValue = Object.values(byType).reduce((sum, t) => sum + t.annualValue, 0);
    const totalMonthlyValue = Math.round(totalAnnualValue / 12);
    const patientsWithOpps = patientCol ? new Set(opportunities.map(o => o.patientKey)).size : 0;
    const uniqueDrugsAnalyzed = allUniqueDrugs.size;

    // Format byType for response
    const byTypeArray = Object.entries(byType).map(([type, data]) => ({
      type,
      count: data.count,
      annualValue: data.annualValue,
    })).sort((a, b) => b.annualValue - a.annualValue);

    // Create analysis record
    const analysisId = uuidv4();
    const isEstimate = !patientCol; // Flag if this is estimate mode
    const analysis = {
      analysisId,
      pharmacyName,
      email,
      totalPatients: patientCol ? patients.size : 0,
      uniqueDrugsAnalyzed,
      patientsWithOpportunities: patientsWithOpps,
      totalOpportunities,
      totalAnnualValue,
      totalMonthlyValue,
      byType: byTypeArray,
      isEstimate, // Let frontend know this is an estimate
      createdAt: new Date().toISOString(),
    };

    // Cache the analysis (expires in 24 hours)
    analysisCache.set(analysisId, {
      ...analysis,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Also store in database for persistence
    try {
      await db.query(`
        INSERT INTO prospect_analyses (analysis_id, pharmacy_name, email, total_patients,
          patients_with_opportunities, total_opportunities, total_annual_value, analysis_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        analysisId, pharmacyName, email, patientCol ? patients.size : uniqueDrugsAnalyzed,
        patientsWithOpps, totalOpportunities, totalAnnualValue,
        JSON.stringify({ byType: byTypeArray, isEstimate, uniqueDrugsAnalyzed })
      ]);
    } catch (dbErr) {
      console.log('Could not persist analysis to DB:', dbErr.message);
      // Continue anyway - cache will work
    }

    res.json({ analysisId, ...analysis });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Analysis failed. Please check your file format.' });
  }
});

// GET /api/prospects/analysis/:analysisId - Get analysis results
router.get('/analysis/:analysisId', async (req, res) => {
  try {
    const { analysisId } = req.params;

    // Check cache first
    const cached = analysisCache.get(analysisId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached);
    }

    // Try database
    const result = await db.query(`
      SELECT * FROM prospect_analyses WHERE analysis_id = $1
    `, [analysisId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Analysis not found or expired' });
    }

    const row = result.rows[0];
    const analysis = {
      analysisId: row.analysis_id,
      pharmacyName: row.pharmacy_name,
      email: row.email,
      totalPatients: row.total_patients,
      patientsWithOpportunities: row.patients_with_opportunities,
      totalOpportunities: row.total_opportunities,
      totalAnnualValue: row.total_annual_value,
      totalMonthlyValue: Math.round(row.total_annual_value / 12),
      byType: row.analysis_data?.byType || [],
    };

    res.json(analysis);

  } catch (error) {
    console.error('Get analysis error:', error);
    res.status(500).json({ error: 'Failed to retrieve analysis' });
  }
});

// POST /api/checkout/create-session - Create Stripe checkout session
router.post('/checkout/create-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const { analysisId, email, pharmacyName } = req.body;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // Your Stripe price ID for $299/mo
          quantity: 1,
        },
      ],
      metadata: {
        analysisId,
        pharmacyName,
      },
      success_url: `${process.env.WEBSITE_URL || 'https://therxos.com'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEBSITE_URL || 'https://therxos.com'}/preview.html?id=${analysisId}`,
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/checkout/webhook - Stripe webhook for payment confirmation
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { analysisId, pharmacyName } = session.metadata;
      const email = session.customer_email;

      // Create client account
      const clientId = uuidv4();
      const pharmacyId = uuidv4();
      const subdomain = pharmacyName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);

      await db.query(`
        INSERT INTO clients (client_id, client_name, dashboard_subdomain, submitter_email, status, stripe_customer_id)
        VALUES ($1, $2, $3, $4, 'active', $5)
      `, [clientId, pharmacyName, subdomain, email, session.customer]);

      await db.query(`
        INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, state, pms_system)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [pharmacyId, clientId, pharmacyName, 'PENDING', 'XX', 'pending']);

      // Create user account (they'll set password on first login)
      const userId = uuidv4();
      await db.query(`
        INSERT INTO users (user_id, client_id, pharmacy_id, email, first_name, role, requires_password_reset)
        VALUES ($1, $2, $3, $4, $5, $6, true)
      `, [userId, clientId, pharmacyId, email, pharmacyName, 'admin']);

      // TODO: Send welcome email with login link

      console.log(`✅ New customer onboarded: ${pharmacyName} (${email})`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook failed' });
  }
});

export default router;
