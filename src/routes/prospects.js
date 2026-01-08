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
  patient_name: ['Patient Full Name Last then First', 'Patient Name', 'PatientName', 'Patient'],
  drug_name: ['Dispensed Item Name', 'Drug Name', 'DrugName', 'Medication', 'Drug'],
  ndc: ['Dispensed Item NDC', 'NDC', 'NDC11'],
  insurance_bin: ['Primary Third Party Bin', 'BIN', 'Bin', 'Insurance BIN'],
  insurance_group: ['Primary Group Number', 'Group', 'Group Number', 'Insurance Group'],
  fill_date: ['Date Written', 'Fill Date', 'Dispensed Date', 'Date'],
  dob: ['Patient Date of Birth', 'DOB', 'Date of Birth', 'Patient DOB'],
};

function findColumn(headers, aliases) {
  for (const alias of aliases) {
    const found = headers.find(h => h.toLowerCase() === alias.toLowerCase());
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

    if (!patientCol || !drugCol) {
      return res.status(400).json({ 
        error: 'Could not identify patient name or drug columns. Please ensure your export includes patient names and drug names.' 
      });
    }

    // Build patient profiles
    const patients = new Map();
    
    for (const row of records) {
      const patientName = row[patientCol]?.trim();
      const drugName = (row[drugCol] || '').toUpperCase();
      
      if (!patientName || !drugName) continue;

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

    // Run opportunity detection
    const opportunities = [];
    const byType = {};

    for (const [patientKey, patient] of patients) {
      const drugList = Array.from(patient.drugs);
      const drugString = drugList.join(' ');

      for (const trigger of QUICK_TRIGGERS) {
        // Check if patient has any detection keywords
        const hasDetect = trigger.detect.some(keyword => 
          drugString.includes(keyword.toUpperCase())
        );
        
        if (!hasDetect) continue;

        // Check exclusions
        if (trigger.exclude) {
          const hasExclude = trigger.exclude.some(keyword =>
            drugString.includes(keyword.toUpperCase())
          );
          if (hasExclude) continue;
        }

        // Check requireMissing (for missing_therapy type)
        if (trigger.requireMissing) {
          const hasMissing = trigger.requireMissing.some(keyword =>
            drugString.includes(keyword.toUpperCase())
          );
          if (hasMissing) continue; // Patient already has it
        }

        // Found an opportunity!
        opportunities.push({
          patientKey,
          triggerId: trigger.id,
          type: trigger.type,
          value: trigger.value,
        });

        // Aggregate by type
        if (!byType[trigger.type]) {
          byType[trigger.type] = { count: 0, annualValue: 0 };
        }
        byType[trigger.type].count++;
        byType[trigger.type].annualValue += trigger.value * 12;
      }
    }

    // Calculate totals
    const totalOpportunities = opportunities.length;
    const totalAnnualValue = opportunities.reduce((sum, opp) => sum + (opp.value * 12), 0);
    const totalMonthlyValue = Math.round(totalAnnualValue / 12);
    const patientsWithOpps = new Set(opportunities.map(o => o.patientKey)).size;

    // Format byType for response
    const byTypeArray = Object.entries(byType).map(([type, data]) => ({
      type,
      count: data.count,
      annualValue: data.annualValue,
    })).sort((a, b) => b.annualValue - a.annualValue);

    // Create analysis record
    const analysisId = uuidv4();
    const analysis = {
      analysisId,
      pharmacyName,
      email,
      totalPatients: patients.size,
      patientsWithOpportunities: patientsWithOpps,
      totalOpportunities,
      totalAnnualValue,
      totalMonthlyValue,
      byType: byTypeArray,
      createdAt: new Date().toISOString(),
      // Don't store patient-level details for preview
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
        analysisId, pharmacyName, email, patients.size,
        patientsWithOpps, totalOpportunities, totalAnnualValue,
        JSON.stringify({ byType: byTypeArray })
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
