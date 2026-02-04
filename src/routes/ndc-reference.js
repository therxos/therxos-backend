// NDC Reference routes for TheRxOS V2
import express from 'express';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Load NDC reference data
let ndcData = null;
try {
  const dataPath = join(__dirname, '../data/diabetic-supplies-ndc.json');
  ndcData = JSON.parse(readFileSync(dataPath, 'utf-8'));
} catch (error) {
  logger.error('Failed to load NDC reference data', { error: error.message });
}

// Get diabetic supplies NDC reference data
router.get('/diabetic-supplies', authenticateToken, async (req, res) => {
  try {
    if (!ndcData) {
      return res.status(500).json({ error: 'NDC reference data not available' });
    }

    const { supplyType, bin, group, search } = req.query;

    let filteredData = [...ndcData.data];

    // Apply filters
    if (supplyType) {
      filteredData = filteredData.filter(item =>
        item.supplyType.toLowerCase() === supplyType.toLowerCase()
      );
    }

    if (bin) {
      filteredData = filteredData.filter(item =>
        item.bin.includes(bin)
      );
    }

    if (group) {
      filteredData = filteredData.filter(item =>
        item.group.toLowerCase().includes(group.toLowerCase())
      );
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filteredData = filteredData.filter(item =>
        item.drugName.toLowerCase().includes(searchLower) ||
        item.ndc.includes(search) ||
        item.bin.includes(search) ||
        item.group.toLowerCase().includes(searchLower)
      );
    }

    // Get unique supply types for filter dropdown
    const supplyTypes = [...new Set(ndcData.data.map(item => item.supplyType))].sort();

    // Get unique BINs for filter dropdown
    const bins = [...new Set(ndcData.data.map(item => item.bin))].sort();

    res.json({
      lastUpdated: ndcData.lastUpdated,
      description: ndcData.description,
      supplyTypes,
      bins,
      data: filteredData,
      total: filteredData.length
    });
  } catch (error) {
    logger.error('NDC reference error', { error: error.message });
    res.status(500).json({ error: 'Failed to get NDC reference data' });
  }
});

export default router;
