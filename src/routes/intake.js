// New Patient Intake Processing
// Uses OpenAI Vision for OCR and trigger matching

import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import db from '../database/index.js';
import { authenticateToken } from './auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf', 'text/csv'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload JPG, PNG, PDF, or CSV.'));
    }
  }
});

// Initialize DeepSeek client (OpenAI-compatible API)
const deepseek = process.env.DEEPSEEK_API_KEY ? new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
}) : null;

/**
 * POST /api/intake/process
 * Process uploaded medication list using OCR and find opportunities
 */
router.post('/process', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { pharmacyId, manualBin, manualPcn, manualGroup } = req.body;
    if (!pharmacyId) {
      return res.status(400).json({ error: 'Pharmacy ID required' });
    }

    logger.info('Processing intake file', {
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      pharmacyId,
      hasManualInsurance: !!(manualBin || manualPcn || manualGroup)
    });

    let extractedData;

    // Handle CSV files differently
    if (req.file.mimetype === 'text/csv') {
      extractedData = parseCSVIntake(req.file.buffer.toString());
    } else if (req.file.mimetype === 'application/pdf') {
      // For PDFs, we'd need pdf-parse or similar - for now return error
      return res.status(400).json({
        error: 'PDF processing coming soon. Please upload an image (JPG/PNG) or CSV for now.'
      });
    } else {
      // Use DeepSeek Vision for images
      if (!deepseek) {
        return res.status(500).json({ error: 'DeepSeek not configured. Please add DEEPSEEK_API_KEY to environment variables.' });
      }

      extractedData = await extractWithVision(req.file.buffer, req.file.mimetype);
    }

    if (!extractedData || !extractedData.medications || extractedData.medications.length === 0) {
      return res.status(400).json({ error: 'Could not extract medication information from the file' });
    }

    // Merge manual insurance with OCR-extracted (manual takes priority)
    const mergedInsurance = {
      bin: (manualBin || '').trim() || extractedData.insurance?.bin || '',
      pcn: (manualPcn || '').trim() || extractedData.insurance?.pcn || '',
      group: (manualGroup || '').trim() || extractedData.insurance?.group || ''
    };

    // Find matching opportunities from triggers
    const opportunities = await findOpportunities(extractedData.medications, pharmacyId);

    const result = {
      patient: extractedData.patient || { firstName: '', lastName: '', dob: '' },
      insurance: mergedInsurance,
      medications: extractedData.medications,
      opportunities
    };

    logger.info('Intake processing complete', {
      medicationsFound: result.medications.length,
      opportunitiesFound: result.opportunities.length
    });

    res.json(result);
  } catch (error) {
    logger.error('Intake processing error:', error);
    res.status(500).json({ error: error.message || 'Failed to process file' });
  }
});

/**
 * POST /api/intake/add-opportunity
 * Add an opportunity from intake to the queue
 */
router.post('/add-opportunity', authenticateToken, async (req, res) => {
  try {
    const { pharmacyId, patient, insurance, opportunity } = req.body;

    if (!pharmacyId || !patient || !opportunity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create or find patient
    let patientId;
    const existingPatient = await db.query(
      `SELECT patient_id FROM patients
       WHERE pharmacy_id = $1
       AND LOWER(first_name) = LOWER($2)
       AND LOWER(last_name) = LOWER($3)
       LIMIT 1`,
      [pharmacyId, patient.firstName, patient.lastName]
    );

    if (existingPatient.rows.length > 0) {
      patientId = existingPatient.rows[0].patient_id;
    } else {
      // Create new patient
      const newPatient = await db.query(
        `INSERT INTO patients (pharmacy_id, first_name, last_name, dob, insurance_bin, insurance_pcn, insurance_group)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING patient_id`,
        [
          pharmacyId,
          patient.firstName,
          patient.lastName,
          patient.dob || null,
          insurance?.bin || null,
          insurance?.pcn || null,
          insurance?.group || null
        ]
      );
      patientId = newPatient.rows[0].patient_id;
    }

    // Create opportunity
    const result = await db.query(
      `INSERT INTO opportunities (
        pharmacy_id, patient_id, opportunity_type, current_drug_name,
        recommended_drug_name, clinical_rationale, status, source
      ) VALUES ($1, $2, $3, $4, $5, $6, 'Not Submitted', 'intake')
      RETURNING opportunity_id`,
      [
        pharmacyId,
        patientId,
        opportunity.type || 'therapeutic_interchange',
        opportunity.current,
        opportunity.recommended,
        opportunity.reason
      ]
    );

    logger.info('Opportunity added from intake', {
      opportunityId: result.rows[0].opportunity_id,
      patientId
    });

    res.json({
      success: true,
      opportunityId: result.rows[0].opportunity_id,
      patientId
    });
  } catch (error) {
    logger.error('Add opportunity error:', error);
    res.status(500).json({ error: 'Failed to add opportunity' });
  }
});

/**
 * Extract patient info, insurance, and medications using DeepSeek Vision
 */
async function extractWithVision(fileBuffer, mimetype) {
  const base64Image = fileBuffer.toString('base64');
  const imageUrl = `data:${mimetype};base64,${base64Image}`;

  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content: `You are a pharmacy intake specialist. Extract patient information, insurance details, and medication list from the provided image.

Return a JSON object with this exact structure:
{
  "patient": {
    "firstName": "string or empty",
    "lastName": "string or empty",
    "dob": "YYYY-MM-DD or empty"
  },
  "insurance": {
    "bin": "6-digit BIN number or empty",
    "pcn": "PCN/processor control number or empty",
    "group": "group number or empty"
  },
  "medications": [
    {
      "name": "medication name with strength",
      "frequency": "dosing frequency if visible"
    }
  ]
}

Important:
- Extract ALL medications visible, including OTC if listed
- Include strength/dose in medication name (e.g., "Lisinopril 10mg" not just "Lisinopril")
- If patient info or insurance not visible, leave those fields empty
- For handwritten text, do your best to interpret
- Return ONLY valid JSON, no other text`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageUrl }
          },
          {
            type: 'text',
            text: 'Extract the patient information, insurance details, and complete medication list from this image.'
          }
        ]
      }
    ],
    max_tokens: 2000,
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from vision model');
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    logger.error('Failed to parse vision response:', content);
    throw new Error('Failed to parse extracted data');
  }
}

/**
 * Parse CSV intake file
 */
function parseCSVIntake(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV file is empty or invalid');
  }

  const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const medications = [];
  let patient = { firstName: '', lastName: '', dob: '' };
  let insurance = { bin: '', pcn: '', group: '' };

  // Find column indices
  const medCol = headers.findIndex(h => h.includes('medication') || h.includes('drug') || h.includes('med'));
  const firstNameCol = headers.findIndex(h => h.includes('first') && h.includes('name'));
  const lastNameCol = headers.findIndex(h => h.includes('last') && h.includes('name'));
  const dobCol = headers.findIndex(h => h.includes('dob') || h.includes('birth') || h.includes('date'));
  const binCol = headers.findIndex(h => h.includes('bin'));
  const pcnCol = headers.findIndex(h => h.includes('pcn'));
  const groupCol = headers.findIndex(h => h.includes('group'));

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));

    // Extract medication
    if (medCol >= 0 && values[medCol]) {
      medications.push({ name: values[medCol], frequency: '' });
    }

    // Extract patient info (from first data row)
    if (i === 1) {
      if (firstNameCol >= 0) patient.firstName = values[firstNameCol] || '';
      if (lastNameCol >= 0) patient.lastName = values[lastNameCol] || '';
      if (dobCol >= 0) patient.dob = values[dobCol] || '';
      if (binCol >= 0) insurance.bin = values[binCol] || '';
      if (pcnCol >= 0) insurance.pcn = values[pcnCol] || '';
      if (groupCol >= 0) insurance.group = values[groupCol] || '';
    }
  }

  // If no medication column found, assume single column of med names
  if (medCol < 0) {
    for (let i = 1; i < lines.length; i++) {
      const value = lines[i].trim().replace(/"/g, '');
      if (value) {
        medications.push({ name: value, frequency: '' });
      }
    }
  }

  return { patient, insurance, medications };
}

/**
 * Find opportunities by matching medications against triggers
 */
async function findOpportunities(medications, pharmacyId) {
  const opportunities = [];

  // Get all active triggers
  const triggersResult = await db.query(
    `SELECT trigger_id, trigger_type, trigger_group, display_name,
            search_terms, recommended_med, clinical_rationale, priority
     FROM triggers
     WHERE is_active = true`
  );

  const triggers = triggersResult.rows;

  // Normalize medication names for matching
  const normalizedMeds = medications.map(m => ({
    original: m.name,
    normalized: m.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()
  }));

  for (const trigger of triggers) {
    // Parse search terms
    let searchTerms = [];
    try {
      searchTerms = typeof trigger.search_terms === 'string'
        ? JSON.parse(trigger.search_terms)
        : trigger.search_terms || [];
    } catch (e) {
      searchTerms = [trigger.search_terms];
    }

    // Check if any medication matches this trigger's search terms
    for (const med of normalizedMeds) {
      const matched = searchTerms.some(term => {
        const normalizedTerm = term.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
        return med.normalized.includes(normalizedTerm) || normalizedTerm.includes(med.normalized.split(' ')[0]);
      });

      if (matched && trigger.recommended_med) {
        // Avoid duplicates
        const exists = opportunities.some(
          o => o.current === med.original && o.recommended === trigger.recommended_med
        );

        if (!exists) {
          opportunities.push({
            type: formatTriggerType(trigger.trigger_type),
            current: med.original,
            recommended: trigger.recommended_med,
            reason: trigger.clinical_rationale || `${trigger.display_name} - therapeutic optimization opportunity`,
            triggerId: trigger.trigger_id,
            priority: trigger.priority
          });
        }
      }
    }
  }

  // Sort by priority
  opportunities.sort((a, b) => {
    const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
  });

  return opportunities;
}

/**
 * Format trigger type for display
 */
function formatTriggerType(type) {
  if (!type) return 'Therapeutic Interchange';
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export default router;
