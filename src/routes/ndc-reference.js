// NDC Reference routes for TheRxOS V2
import express from 'express';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Embedded NDC reference data (more reliable than file reading in containers)
const ndcData = {
  lastUpdated: "2026-01-28",
  description: "Best NDC recommendations for diabetic supplies by insurance BIN/GROUP",
  data: [
    {rank: 1, supplyType: "Glucometers", bin: "003858", group: "2ENA", ndc: "", drugName: "True Metrix Blood Glucosemeter W/Device Kit Triv", gp100: 10.82},
    {rank: 1, supplyType: "Glucometers", bin: "003858", group: "BSLA", ndc: "", drugName: "True Metrix Blood Glucosemeter W/Device Kit Triv", gp100: -0.15},
    {rank: 1, supplyType: "Glucometers", bin: "003858", group: "TRRX", ndc: "", drugName: "Freestyle Lite Blood Glucose Monitoring System Mis", gp100: 0.00},
    {rank: 1, supplyType: "Glucometers", bin: "004336", group: "RX24BE", ndc: "53885004601", drugName: "Onetouch Kit Ultra 2", gp100: -0.93},
    {rank: 1, supplyType: "Glucometers", bin: "004336", group: "RX5844", ndc: "65702072910", drugName: "Accu-Chek Kit Guide", gp100: 2.39},
    {rank: 1, supplyType: "Glucometers", bin: "004336", group: "UMWA", ndc: "56151147002", drugName: "True Metrix Kit Meter", gp100: 8.25},
    {rank: 1, supplyType: "Glucometers", bin: "610014", group: "HMRK001", ndc: "56151147002", drugName: "True Metrix Kit Meter", gp100: -1.30},
    {rank: 1, supplyType: "Glucometers", bin: "610097", group: "COS", ndc: "65702073110", drugName: "Accu-Chek Kit Guide Me", gp100: -0.23},
    {rank: 1, supplyType: "Glucometers", bin: "610494", group: "ACULA", ndc: "", drugName: "True Metrix Blood Glucosemeter W/Device Kit Triv", gp100: 10.82},
    {rank: 1, supplyType: "Glucometers", bin: "610502", group: "RXAETD", ndc: "65702073110", drugName: "Accu-Chek Kit Guide Me", gp100: -1.11},
    {rank: 1, supplyType: "Insulin Syringes", bin: "003858", group: "PMDM", ndc: "94046000170", drugName: "Insulin Syringe 31G 0.5ML 5/16", gp100: 0.00},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610014", group: "SPBLUE1", ndc: "98302013919", drugName: "Insulin Syrg Mis 1ML/31G", gp100: 83.17},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610014", group: "SPBLUE2", ndc: "98302013930", drugName: "Insulin Syrg Mis 0.5/31G", gp100: 168.20},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610097", group: "COS", ndc: "86227090055", drugName: "Insulin Syrg Mis 0.5/29g", gp100: 33.46},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610097", group: "MPDMA2CSP", ndc: "86227065105", drugName: "Insulin Syrg Mis 1ml/31g", gp100: 33.46},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610097", group: "MPDMACSP", ndc: "98302013930", drugName: "Insulin Syrg Mis 0.5/31g Comfo", gp100: 88.39},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610097", group: "PSR", ndc: "08222093554", drugName: "Insulin Syrg 0.5/30g Mis Misc", gp100: 13.00},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610494", group: "ACUMI", ndc: "08290328418", drugName: "Bd Insulin Syr 1 Ml 31gx5/1", gp100: 10.54},
    {rank: 1, supplyType: "Insulin Syringes", bin: "610502", group: "RXAETD", ndc: "08290328438", drugName: "Bd Insulin Syr 0.3ml 31gx5/", gp100: -2.33},
    {rank: 1, supplyType: "Lancets", bin: "003858", group: "2DBA", ndc: "56151014260", drugName: "Lancets", gp100: 3.75},
    {rank: 1, supplyType: "Lancets", bin: "003858", group: "2ENA", ndc: "", drugName: "Trueplus 33g Lancets", gp100: 14.31},
    {rank: 1, supplyType: "Lancets", bin: "003858", group: "2EPA", ndc: "56151014260", drugName: "Lancets", gp100: 13.14},
    {rank: 1, supplyType: "Lancets", bin: "003858", group: "BSLA", ndc: "", drugName: "Trueplus Lancets 28g Mis Triv", gp100: 4.72},
    {rank: 1, supplyType: "Lancets", bin: "003858", group: "MAHLTH", ndc: "60003012556", drugName: "Pure Comfort 30g Safety Lancet", gp100: 88.66},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "CVS", ndc: "06000312556", drugName: "Safety Lancet 30G/Pressure", gp100: 88.56},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "RX1110", ndc: "91237000117", drugName: "Lancet Device (Alpine)", gp100: 41.84},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "RX24BE", ndc: "60003012556", drugName: "Pure Comfort 30g Safety Lancet", gp100: 70.24},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "RX5038", ndc: "91237000116", drugName: "Easy Comfort Lancets 30g", gp100: 42.93},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "rx8585", ndc: "73317468201", drugName: "Lancets", gp100: 81.71},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "RX8585", ndc: "73317461001", drugName: "Lancets (Akron)", gp100: 43.88},
    {rank: 1, supplyType: "Lancets", bin: "004336", group: "UMWA", ndc: "90166013004", drugName: "Global 30G Mis Lancets", gp100: 33.76},
    {rank: 1, supplyType: "Lancets", bin: "015581", group: "HUME", ndc: "05615114401", drugName: "Trueplus Lancets 30G Misc", gp100: 0.31},
    {rank: 1, supplyType: "Lancets", bin: "610011", group: "RX1653", ndc: "99073013001", drugName: "Freestyle Lancets 100ct", gp100: 10.02},
    {rank: 1, supplyType: "Lancets", bin: "610011", group: "RXMEDD", ndc: "60003012556", drugName: "Pure Comfort 30g Safety Lancet", gp100: 80.93},
    {rank: 1, supplyType: "Lancets", bin: "610014", group: "2FFA", ndc: "56151014701", drugName: "Truplus Lancet 33g Mis", gp100: 9.90},
    {rank: 1, supplyType: "Lancets", bin: "610014", group: "MEDCO-D", ndc: "06000312556", drugName: "Safety Lancet 30G/Pressure", gp100: 65.87},
    {rank: 1, supplyType: "Lancets", bin: "610014", group: "PITCMDRX", ndc: "60003012556", drugName: "Safety 30G Mis Lancets", gp100: 71.72},
    {rank: 1, supplyType: "Lancets", bin: "610014", group: "SCOPT001", ndc: "91237000116", drugName: "Easy Comfort Lancets 30g", gp100: 48.92},
    {rank: 1, supplyType: "Lancets", bin: "610097", group: "COS", ndc: "60003012556", drugName: "Safety 30G Mis Lancets", gp100: 79.63},
    {rank: 1, supplyType: "Lancets", bin: "610097", group: "MPDCSP", ndc: "73317468201", drugName: "Lancets", gp100: 86.88},
    {rank: 1, supplyType: "Lancets", bin: "610097", group: "MPDMACSP", ndc: "60003012556", drugName: "Pure Comfort 30g Safety Lancet", gp100: 74.94},
    {rank: 1, supplyType: "Lancets", bin: "610494", group: "ACULA", ndc: "", drugName: "Accu-Chek Softclix Lancets Mis Roch", gp100: 10.61},
    {rank: 1, supplyType: "Lancets", bin: "610494", group: "ACUMA", ndc: "99073013001", drugName: "Freestyle Lancets 100ct", gp100: 13.87},
    {rank: 1, supplyType: "Lancets", bin: "610494", group: "ACUMI", ndc: "56151014260", drugName: "Lancets", gp100: 13.14},
    {rank: 1, supplyType: "Lancets", bin: "610502", group: "RXAETD", ndc: "56151014401", drugName: "Truplus Lancet 30g Mis", gp100: 8.56},
    {rank: 1, supplyType: "Pen Needles", bin: "003858", group: "2EEA", ndc: "52982000615", drugName: "Advocate Pen Needle 4mm 33g", gp100: 103.57},
    {rank: 1, supplyType: "Pen Needles", bin: "003858", group: "2ENA", ndc: "", drugName: "Nano 2 Gen Pen Needle 32g 4mm", gp100: 13.63},
    {rank: 1, supplyType: "Pen Needles", bin: "003858", group: "2EPA", ndc: "83017055003", drugName: "Embecta Pen Needle Nano 2nd", gp100: 13.24},
    {rank: 1, supplyType: "Pen Needles", bin: "003858", group: "BSLA", ndc: "", drugName: "Comfort Ez Pen Needles 5mm 31g", gp100: 96.76},
    {rank: 1, supplyType: "Pen Needles", bin: "003858", group: "PMDM", ndc: "91237000177", drugName: "Easy Comf Pen Ndl 32gx5/32", gp100: 65.21},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "CVS", ndc: "09830214059", drugName: "Comfort Ez Pen Ndl 4mm 32g", gp100: 108.08},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "RX24BE", ndc: "87701019063", drugName: "Gnp Pen Needle 31g 8mm", gp100: 45.53},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "RX3892", ndc: "94030000213", drugName: "Embrace Pen Needle 32g 4mm", gp100: 39.89},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "RX5004", ndc: "08290320749", drugName: "Bd Pen Needle Micro U/F 32g", gp100: 62.24},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "RXCVSD", ndc: "87701019060", drugName: "Gnp Pen Needle 32g 4mm", gp100: 48.56},
    {rank: 1, supplyType: "Pen Needles", bin: "004336", group: "UMWA", ndc: "8489847010", drugName: "Pen Needles Mis 31Gx5/16", gp100: 26.36},
    {rank: 1, supplyType: "Pen Needles", bin: "015581", group: "9A570", ndc: "8489847010", drugName: "Pen Needles Mis 31Gx5/16", gp100: 43.20},
    {rank: 1, supplyType: "Pen Needles", bin: "015581", group: "HUME", ndc: "08489847210", drugName: "Pen Needles 33G X 4 Mm Misc", gp100: 13.65},
    {rank: 1, supplyType: "Pen Needles", bin: "015581", group: "P5453", ndc: "8489847110", drugName: "Pen Needles Mis 32Gx5/32", gp100: 15.68},
    {rank: 1, supplyType: "Pen Needles", bin: "015581", group: "W1579", ndc: "8489846810", drugName: "Pen Needles Mis 31Gx3/16", gp100: 14.60},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "BCBSMAN", ndc: "08496310601", drugName: "Easy Touch Pen Ndl 31gx5/16", gp100: 32.48},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "EGWPS053", ndc: "8489847110", drugName: "Pen Needles Mis 32Gx5/32", gp100: 30.07},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "MDCMEDD", ndc: "98302014059", drugName: "Comfort Ez Pen Needles 4mm 32g", gp100: 89.47},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "PURSYR", ndc: "50002086003", drugName: "Comfort Ez Pen Needles 5mm 31g", gp100: 31.26},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "RXMEDD", ndc: "87701019063", drugName: "Gnp Pen Needle 31g 8mm", gp100: 48.26},
    {rank: 1, supplyType: "Pen Needles", bin: "610011", group: "TNYHT", ndc: "94030000213", drugName: "Embrace Pen Needle 32g 4mm", gp100: 36.24},
    {rank: 1, supplyType: "Pen Needles", bin: "610014", group: "2FFA", ndc: "83017010903", drugName: "Embecta Pen Needle 31g 8mm", gp100: 14.89},
    {rank: 1, supplyType: "Pen Needles", bin: "610014", group: "2FGA", ndc: "83017011903", drugName: "Embecta Pen Needle 31g 5mm", gp100: 13.94},
    {rank: 1, supplyType: "Pen Needles", bin: "610014", group: "GMP0000", ndc: "", drugName: "Trueplus Pen Needle 31gx5/16", gp100: 17.57},
    {rank: 1, supplyType: "Pen Needles", bin: "610014", group: "MXS000015154693", ndc: "", drugName: "Trueplus Pen Needle 31gx3/16", gp100: 41.38},
    {rank: 1, supplyType: "Pen Needles", bin: "610014", group: "SPBLUE2", ndc: "98302014059", drugName: "Comfort Ez Pen Needles 4mm 32g", gp100: 95.96},
    {rank: 1, supplyType: "Pen Needles", bin: "610097", group: "COS", ndc: "98302014059", drugName: "Comfort Ez Mis 32Gx4mm", gp100: 90.40},
    {rank: 1, supplyType: "Pen Needles", bin: "610097", group: "MPDCSP", ndc: "94046000173", drugName: "Advocate Pen Needles 8mm 31g", gp100: 90.38},
    {rank: 1, supplyType: "Pen Needles", bin: "610097", group: "MPDMACSP", ndc: "98302000198", drugName: "Comfort Ez Pen Needles 8mm 31g", gp100: 93.00},
    {rank: 1, supplyType: "Pen Needles", bin: "610097", group: "MPDURS", ndc: "98302000199", drugName: "Comfort Ez Pen Needles 5mm 31g", gp100: 87.49},
    {rank: 1, supplyType: "Pen Needles", bin: "610097", group: "PDPIND", ndc: "94046000174", drugName: "Advocate Pen Needles 5mm 31g", gp100: 90.38},
    {rank: 1, supplyType: "Pen Needles", bin: "610494", group: "ACUMI", ndc: "08290328203", drugName: "Bd Pen Needle Orig 29gx1/2", gp100: 40.82},
    {rank: 1, supplyType: "Pen Needles", bin: "610502", group: "RXAETD", ndc: "50002086002", drugName: "Comfort Ez Pen Needles 8mm 31g", gp100: 34.44},
    {rank: 1, supplyType: "Swabs", bin: "004336", group: "CVS", ndc: "06237900506", drugName: "Pharm Choice Alcohol Prep P", gp100: 56.81},
    {rank: 1, supplyType: "Swabs", bin: "004336", group: "RX0506", ndc: "46122004378", drugName: "Gnp Alcohol Swab", gp100: 11.38},
    {rank: 1, supplyType: "Swabs", bin: "004336", group: "RX1400", ndc: "62379000506", drugName: "Alcohol Prep Pad 70%", gp100: 62.05},
    {rank: 1, supplyType: "Swabs", bin: "004336", group: "RX23EA", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 50.62},
    {rank: 1, supplyType: "Swabs", bin: "610014", group: "2FGA", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 52.71},
    {rank: 1, supplyType: "Swabs", bin: "610097", group: "COS", ndc: "62379000506", drugName: "Alcohol Prep Pad 70%", gp100: 48.41},
    {rank: 1, supplyType: "Swabs", bin: "610097", group: "MPDCSP", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 49.49},
    {rank: 1, supplyType: "Swabs", bin: "610097", group: "MPDURS", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 43.28},
    {rank: 1, supplyType: "Swabs", bin: "610097", group: "PDPIND", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 44.59},
    {rank: 1, supplyType: "Swabs", bin: "610097", group: "PSR", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 52.61},
    {rank: 1, supplyType: "Swabs", bin: "610494", group: "ACUMI", ndc: "46122004378", drugName: "Gnp Alcohol Swab", gp100: 11.38},
    {rank: 1, supplyType: "Swabs", bin: "610502", group: "RXAETD", ndc: "62379000506", drugName: "Pharm Choice Alcohol Prep Pads", gp100: 46.32},
    {rank: 1, supplyType: "Test Strips", bin: "003858", group: "PMDA", ndc: "53885024450", drugName: "One Touch Ultra Test Strips", gp100: 13.99},
    {rank: 1, supplyType: "Test Strips", bin: "004336", group: "FUN", ndc: "05388527150", drugName: "One Touch Verio Test Strips", gp100: 12.75},
    {rank: 1, supplyType: "Test Strips", bin: "004336", group: "RX1400", ndc: "94030000271", drugName: "Embrace Talk Tes Strips", gp100: 11.09},
    {rank: 1, supplyType: "Test Strips", bin: "004336", group: "RX7117", ndc: "53885027210", drugName: "Onetouch Verio Test Strip", gp100: 20.22},
    {rank: 1, supplyType: "Test Strips", bin: "004336", group: "RX8737", ndc: "00193731150", drugName: "Contour Next Test Strip", gp100: 18.84},
    {rank: 1, supplyType: "Test Strips", bin: "610014", group: "PITCMDRX", ndc: "94030000271", drugName: "Embrace Talk Tes Strips", gp100: 26.71},
    {rank: 1, supplyType: "Test Strips", bin: "610097", group: "COS", ndc: "94030000271", drugName: "Embrace Talk Tes Strips", gp100: 30.70},
    {rank: 1, supplyType: "Test Strips", bin: "610494", group: "ACUMA", ndc: "65702071110", drugName: "Accu-Chek Guide Test Strip", gp100: 13.68},
    {rank: 1, supplyType: "Test Strips", bin: "610494", group: "ACUMI", ndc: "00193758450", drugName: "Contour Plus Test Strip", gp100: 10.64}
  ]
};

// Get diabetic supplies NDC reference data
router.get('/diabetic-supplies', authenticateToken, async (req, res) => {
  try {
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
