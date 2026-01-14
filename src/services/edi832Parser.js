// EDI 832 Price/Sales Catalog Parser
// Parses 832 files from wholesalers/PBMs containing drug pricing and rebate information
// Supports ANSI X12 832 format

import { logger } from '../utils/logger.js';
import db from '../database/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

/**
 * Parse EDI 832 file and extract pricing/rebate data
 * @param {string} filePath - Path to 832 file
 * @param {string} source - Source identifier (e.g., 'mckesson', 'amerisource', 'cardinal')
 * @returns {Object} Parsed pricing data and stats
 */
export async function parse832File(filePath, source = 'unknown') {
  const batchId = `832_${Date.now()}_${uuidv4().slice(0, 8)}`;
  logger.info('Parsing 832 file', { batchId, filePath, source });

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Detect delimiter (~ for segment, * for element)
    const segmentDelimiter = content.includes('~') ? '~' : '\n';
    const elementDelimiter = content.includes('*') ? '*' : '|';

    const segments = content.split(segmentDelimiter).map(s => s.trim()).filter(Boolean);

    const pricingRecords = [];
    let currentItem = null;
    let header = {
      senderId: null,
      receiverId: null,
      date: null,
      contractId: null,
      effectiveDate: null,
      expirationDate: null
    };

    for (const segment of segments) {
      const elements = segment.split(elementDelimiter);
      const segmentId = elements[0];

      switch (segmentId) {
        case 'ISA': // Interchange Control Header
          header.senderId = elements[6]?.trim();
          header.receiverId = elements[8]?.trim();
          header.date = parseEDIDate(elements[9]);
          break;

        case 'GS': // Functional Group Header
          header.date = parseEDIDate(elements[4]);
          break;

        case 'BCT': // Beginning Segment for Price/Sales Catalog
          header.contractId = elements[2];
          break;

        case 'DTM': // Date/Time Reference
          const dateQualifier = elements[1];
          const dateValue = parseEDIDate(elements[2]);
          if (dateQualifier === '007') header.effectiveDate = dateValue; // Effective date
          if (dateQualifier === '036') header.expirationDate = dateValue; // Expiration date
          break;

        case 'LIN': // Item Identification
          // Save previous item if exists
          if (currentItem && currentItem.ndc) {
            pricingRecords.push({ ...currentItem });
          }

          currentItem = {
            ndc: null,
            upc: null,
            description: null,
            wac: null, // Wholesale Acquisition Cost
            contractPrice: null,
            rebateAmount: null,
            effectiveDate: header.effectiveDate,
            expirationDate: header.expirationDate,
            contractId: header.contractId,
            source
          };

          // Parse product identifiers
          for (let i = 1; i < elements.length; i += 2) {
            const qualifier = elements[i];
            const value = elements[i + 1];
            if (qualifier === 'N4' || qualifier === 'ND') currentItem.ndc = formatNDC(value);
            if (qualifier === 'UP' || qualifier === 'UK') currentItem.upc = value;
          }
          break;

        case 'PID': // Product/Item Description
          if (currentItem) {
            currentItem.description = elements[5] || elements[4];
          }
          break;

        case 'CTP': // Pricing Information
          if (currentItem) {
            const priceQualifier = elements[1];
            const price = parseFloat(elements[3]) || 0;
            const quantityBasis = elements[4]; // Usually 'UN' for unit
            const quantityAmount = parseFloat(elements[5]) || 1;

            // Normalize to per-unit price
            const perUnitPrice = quantityAmount > 0 ? price / quantityAmount : price;

            switch (priceQualifier) {
              case 'AWP': // Average Wholesale Price
              case 'WHP': // Wholesale Price
              case 'WS': // Wholesale
                currentItem.wac = perUnitPrice;
                break;
              case 'CON': // Contract Price
              case 'NET': // Net Price
              case 'RES': // Resale Price
                currentItem.contractPrice = perUnitPrice;
                break;
              case 'MSR': // Manufacturer's Suggested Retail
                currentItem.msrp = perUnitPrice;
                break;
              case 'RBT': // Rebate
              case 'DIS': // Discount
                currentItem.rebateAmount = perUnitPrice;
                break;
            }
          }
          break;

        case 'G43': // Promotion/Price List Area
          if (currentItem && elements[2]) {
            // Contract pricing with rebate info
            currentItem.contractPrice = parseFloat(elements[2]) || currentItem.contractPrice;
            if (elements[4]) {
              currentItem.rebateAmount = parseFloat(elements[4]);
            }
          }
          break;

        case 'SAC': // Service, Promotion, Allowance, or Charge
          if (currentItem) {
            const chargeType = elements[2];
            const amount = parseFloat(elements[5]) || 0;

            if (['D240', 'D250', 'REB', 'RBT'].includes(chargeType)) {
              currentItem.rebateAmount = (currentItem.rebateAmount || 0) + amount;
            }
          }
          break;
      }
    }

    // Don't forget the last item
    if (currentItem && currentItem.ndc) {
      pricingRecords.push({ ...currentItem });
    }

    logger.info('832 parsing complete', {
      batchId,
      recordsParsed: pricingRecords.length,
      contractId: header.contractId,
      source
    });

    return {
      batchId,
      header,
      records: pricingRecords,
      stats: {
        totalRecords: pricingRecords.length,
        withWAC: pricingRecords.filter(r => r.wac).length,
        withContractPrice: pricingRecords.filter(r => r.contractPrice).length,
        withRebate: pricingRecords.filter(r => r.rebateAmount).length
      }
    };

  } catch (error) {
    logger.error('832 parsing failed', { batchId, error: error.message });
    throw error;
  }
}

/**
 * Load parsed 832 data into database
 */
export async function load832Data(parsedData) {
  const { batchId, header, records } = parsedData;
  logger.info('Loading 832 data to database', { batchId, recordCount: records.length });

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const record of records) {
    try {
      if (!record.ndc) continue;

      // Calculate effective reimbursement rate
      // Priority: contract price - rebate, then WAC - rebate, then contract price, then WAC
      let reimbursementRate = null;
      if (record.contractPrice) {
        reimbursementRate = record.contractPrice - (record.rebateAmount || 0);
      } else if (record.wac) {
        reimbursementRate = record.wac - (record.rebateAmount || 0);
      }

      // Upsert into drug_pricing table
      const result = await db.query(`
        INSERT INTO drug_pricing (
          pricing_id,
          ndc,
          contract_id,
          wac,
          contract_price,
          rebate_amount,
          reimbursement_rate,
          effective_date,
          expiration_date,
          source,
          batch_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (ndc, contract_id, source)
        DO UPDATE SET
          wac = EXCLUDED.wac,
          contract_price = EXCLUDED.contract_price,
          rebate_amount = EXCLUDED.rebate_amount,
          reimbursement_rate = EXCLUDED.reimbursement_rate,
          effective_date = EXCLUDED.effective_date,
          expiration_date = EXCLUDED.expiration_date,
          batch_id = EXCLUDED.batch_id,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        uuidv4(),
        record.ndc,
        record.contractId || header.contractId,
        record.wac,
        record.contractPrice,
        record.rebateAmount,
        reimbursementRate,
        record.effectiveDate || header.effectiveDate,
        record.expirationDate || header.expirationDate,
        record.source,
        batchId
      ]);

      if (result.rows[0]?.inserted) {
        inserted++;
      } else {
        updated++;
      }

      // Also update medicare_formulary if this is Medicare pricing
      if (record.contractId?.match(/^[HSR]\d{4}$/)) {
        await db.query(`
          INSERT INTO medicare_formulary (
            formulary_id,
            contract_id,
            ndc,
            reimbursement_rate,
            effective_date,
            expiration_date,
            source,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (contract_id, ndc)
          DO UPDATE SET
            reimbursement_rate = COALESCE(EXCLUDED.reimbursement_rate, medicare_formulary.reimbursement_rate),
            updated_at = NOW()
        `, [
          uuidv4(),
          record.contractId,
          record.ndc,
          reimbursementRate,
          record.effectiveDate,
          record.expirationDate,
          record.source
        ]);
      }

    } catch (error) {
      logger.error('Failed to insert 832 record', { ndc: record.ndc, error: error.message });
      errors++;
    }
  }

  logger.info('832 data load complete', { batchId, inserted, updated, errors });

  return { batchId, inserted, updated, errors };
}

/**
 * Parse EDI date format (YYYYMMDD or YYMMDD)
 */
function parseEDIDate(dateStr) {
  if (!dateStr) return null;

  // Remove any non-numeric characters
  const cleanDate = dateStr.replace(/\D/g, '');

  if (cleanDate.length === 8) {
    // YYYYMMDD
    return new Date(
      parseInt(cleanDate.slice(0, 4)),
      parseInt(cleanDate.slice(4, 6)) - 1,
      parseInt(cleanDate.slice(6, 8))
    );
  } else if (cleanDate.length === 6) {
    // YYMMDD - assume 2000s
    const year = parseInt(cleanDate.slice(0, 2));
    return new Date(
      year > 50 ? 1900 + year : 2000 + year,
      parseInt(cleanDate.slice(2, 4)) - 1,
      parseInt(cleanDate.slice(4, 6))
    );
  }

  return null;
}

/**
 * Format NDC to 11-digit standard format
 */
function formatNDC(ndc) {
  if (!ndc) return null;

  // Remove any dashes or spaces
  const clean = ndc.replace(/[-\s]/g, '');

  // Pad to 11 digits if needed
  return clean.padStart(11, '0');
}

/**
 * Parse CSV-formatted pricing file (simpler alternative to EDI)
 * Many wholesalers also provide CSV exports
 */
export async function parseCSVPricingFile(filePath, source, options = {}) {
  const batchId = `csv_pricing_${Date.now()}`;
  logger.info('Parsing CSV pricing file', { batchId, filePath, source });

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

    if (lines.length < 2) {
      throw new Error('CSV file appears empty or has no data rows');
    }

    // Parse header to find column indices
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));

    const columnMap = {
      ndc: headers.findIndex(h => h.includes('ndc') || h === 'product_id'),
      description: headers.findIndex(h => h.includes('description') || h.includes('drug_name') || h.includes('name')),
      wac: headers.findIndex(h => h.includes('wac') || h.includes('wholesale') || h.includes('awp')),
      contractPrice: headers.findIndex(h => h.includes('contract') || h.includes('net') || h.includes('price')),
      rebate: headers.findIndex(h => h.includes('rebate') || h.includes('discount') || h.includes('allowance')),
      effectiveDate: headers.findIndex(h => h.includes('effective') || h.includes('start')),
      expirationDate: headers.findIndex(h => h.includes('expir') || h.includes('end'))
    };

    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);

      const ndc = formatNDC(values[columnMap.ndc]);
      if (!ndc) continue;

      records.push({
        ndc,
        description: values[columnMap.description] || null,
        wac: parseFloat(values[columnMap.wac]) || null,
        contractPrice: parseFloat(values[columnMap.contractPrice]) || null,
        rebateAmount: parseFloat(values[columnMap.rebate]) || null,
        effectiveDate: columnMap.effectiveDate >= 0 ? new Date(values[columnMap.effectiveDate]) : null,
        expirationDate: columnMap.expirationDate >= 0 ? new Date(values[columnMap.expirationDate]) : null,
        contractId: options.contractId || null,
        source
      });
    }

    logger.info('CSV pricing parsing complete', { batchId, recordsParsed: records.length });

    return {
      batchId,
      header: { contractId: options.contractId, source },
      records,
      stats: {
        totalRecords: records.length,
        withWAC: records.filter(r => r.wac).length,
        withContractPrice: records.filter(r => r.contractPrice).length,
        withRebate: records.filter(r => r.rebateAmount).length
      }
    };

  } catch (error) {
    logger.error('CSV pricing parsing failed', { batchId, error: error.message });
    throw error;
  }
}

/**
 * Parse CSV line handling quoted values with commas
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  return values;
}

/**
 * Process all 832 files in a directory
 */
export async function process832Directory(dirPath, source) {
  logger.info('Processing 832 directory', { dirPath, source });

  const files = await fs.readdir(dirPath);
  const ediFiles = files.filter(f => f.endsWith('.832') || f.endsWith('.edi') || f.endsWith('.txt'));

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const file of ediFiles) {
    try {
      const filePath = path.join(dirPath, file);
      const parsed = await parse832File(filePath, source);
      const result = await load832Data(parsed);

      totalInserted += result.inserted;
      totalUpdated += result.updated;
      totalErrors += result.errors;

    } catch (error) {
      logger.error('Failed to process 832 file', { file, error: error.message });
      totalErrors++;
    }
  }

  return { filesProcessed: ediFiles.length, totalInserted, totalUpdated, totalErrors };
}

export default {
  parse832File,
  load832Data,
  parseCSVPricingFile,
  process832Directory
};
