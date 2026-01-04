// Patient routes for TheRxOS V2
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get patients for pharmacy
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { search, hasOpportunities, condition, limit = 50, offset = 0 } = req.query;
    const pharmacyId = req.user.pharmacyId;

    let query = `
      SELECT p.*,
        (SELECT COUNT(*) FROM opportunities o WHERE o.patient_id = p.patient_id AND o.status = 'Not Submitted') as opportunity_count,
        (SELECT SUM(potential_margin_gain) FROM opportunities o WHERE o.patient_id = p.patient_id AND o.status = 'Not Submitted') as potential_margin,
        (SELECT MAX(dispensed_date) FROM prescriptions pr WHERE pr.patient_id = p.patient_id) as last_fill_date,
        (SELECT COUNT(*) FROM prescriptions pr WHERE pr.patient_id = p.patient_id AND pr.dispensed_date >= NOW() - INTERVAL '12 months') as rx_count_12m
      FROM patients p
      WHERE p.pharmacy_id = $1
    `;
    const params = [pharmacyId];
    let paramIndex = 2;

    if (search) {
      query += ` AND p.patient_hash ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }
    if (hasOpportunities === 'true') {
      query += ` AND EXISTS (SELECT 1 FROM opportunities o WHERE o.patient_id = p.patient_id AND o.status = 'Not Submitted')`;
    }
    if (condition) {
      query += ` AND $${paramIndex++} = ANY(p.chronic_conditions)`;
      params.push(condition);
    }

    query += ` ORDER BY opportunity_count DESC NULLS LAST, last_fill_date DESC NULLS LAST`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    const countResult = await db.query(`SELECT COUNT(*) as total FROM patients WHERE pharmacy_id = $1`, [pharmacyId]);

    res.json({
      patients: result.rows,
      total: parseInt(countResult.rows[0].total),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    logger.error('Get patients error', { error: error.message });
    res.status(500).json({ error: 'Failed to get patients' });
  }
});

// Get single patient profile
router.get('/:patientId', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;

    const patient = await db.query(`SELECT p.* FROM patients p WHERE p.patient_id = $1 AND p.pharmacy_id = $2`, [patientId, req.user.pharmacyId]);
    if (patient.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const medications = await db.query(`
      SELECT pr.*, nr.therapeutic_class, nr.is_brand, nr.is_controlled
      FROM prescriptions pr
      LEFT JOIN ndc_reference nr ON nr.ndc = pr.ndc
      WHERE pr.patient_id = $1
      ORDER BY pr.dispensed_date DESC LIMIT 100
    `, [patientId]);

    const opportunities = await db.query(`
      SELECT * FROM opportunities WHERE patient_id = $1 AND status IN ('new', 'reviewed')
      ORDER BY potential_margin_gain DESC
    `, [patientId]);

    const drugClasses = [...new Set(medications.rows.map(m => m.therapeutic_class).filter(Boolean))];

    const medSyncCheck = await db.query(`
      SELECT COUNT(*) as chronic_med_count FROM (
        SELECT DISTINCT drug_name FROM prescriptions
        WHERE patient_id = $1 AND dispensed_date >= NOW() - INTERVAL '6 months'
        GROUP BY drug_name HAVING COUNT(*) >= 2
      ) chronic_meds
    `, [patientId]);

    const isMedSyncCandidate = parseInt(medSyncCheck.rows[0].chronic_med_count) >= 3;

    res.json({
      patient: patient.rows[0],
      prescriptions: medications.rows,
      opportunities: opportunities.rows,
      drugClasses,
      isMedSyncCandidate,
      summary: {
        totalMedications: medications.rows.length,
        chronicConditions: patient.rows[0].chronic_conditions || [],
        activeOpportunities: opportunities.rows.length,
        potentialMargin: opportunities.rows.reduce((sum, o) => sum + (parseFloat(o.potential_margin_gain) || 0), 0)
      }
    });
  } catch (error) {
    logger.error('Get patient error', { error: error.message });
    res.status(500).json({ error: 'Failed to get patient' });
  }
});

// Enroll patient in med sync
router.post('/:patientId/med-sync', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { syncDate } = req.body;

    if (!syncDate || syncDate < 1 || syncDate > 28) {
      return res.status(400).json({ error: 'Sync date must be between 1 and 28' });
    }

    const existing = await db.query(`SELECT sync_id FROM med_sync_patients WHERE patient_id = $1 AND status = 'active'`, [patientId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Patient already enrolled in med sync' });
    }

    const meds = await db.query(`
      SELECT DISTINCT drug_name, ndc, days_supply FROM prescriptions
      WHERE patient_id = $1 AND dispensed_date >= NOW() - INTERVAL '6 months'
      GROUP BY drug_name, ndc, days_supply HAVING COUNT(*) >= 2
    `, [patientId]);

    const result = await db.insert('med_sync_patients', {
      sync_id: uuidv4(),
      patient_id: patientId,
      pharmacy_id: req.user.pharmacyId,
      sync_date: syncDate,
      enrolled_by: req.user.userId,
      medications: JSON.stringify(meds.rows),
      next_sync_due: new Date(new Date().setDate(syncDate))
    });

    await db.query('UPDATE patients SET med_sync_enrolled = true, med_sync_date = $1 WHERE patient_id = $2', [syncDate, patientId]);

    logger.info('Patient enrolled in med sync', { patientId, syncDate, userId: req.user.userId });

    res.status(201).json({ success: true, enrollment: result, medications: meds.rows });
  } catch (error) {
    logger.error('Med sync enrollment error', { error: error.message });
    res.status(500).json({ error: 'Failed to enroll in med sync' });
  }
});

export default router;
