// Document Generator Service for TheRxOS V2
// Generates personalized BAA and Service Agreement documents

import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');

/**
 * Generate a document from a template with placeholder replacement
 * @param {string} templateName - 'BAA' or 'ServiceAgreement'
 * @param {object} data - Data to replace placeholders
 * @returns {Buffer} - Generated document as buffer
 */
export async function generateDocument(templateName, data) {
  const templatePath = path.join(rootDir, `${templateName}.docx`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  // Read the template
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  // Create docxtemplater instance
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Handle missing tags gracefully
    nullGetter: () => '',
  });

  // Format date
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Prepare template data with common fields
  const templateData = {
    // Common fields
    DATE: formattedDate,
    EFFECTIVE_DATE: formattedDate,
    COMPANY_NAME: data.companyName || data.pharmacyName,
    PHARMACY_NAME: data.pharmacyName,
    CLIENT_NAME: data.clientName || data.pharmacyName,
    CONTACT_NAME: data.contactName || '',
    CONTACT_EMAIL: data.email,
    EMAIL: data.email,
    ADDRESS: data.address || '',
    CITY: data.city || '',
    STATE: data.state || '',
    ZIP: data.zip || '',
    PHONE: data.phone || '',
    NPI: data.npi || '',

    // Lowercase variants (some templates use these)
    date: formattedDate,
    company_name: data.companyName || data.pharmacyName,
    pharmacy_name: data.pharmacyName,
    email: data.email,

    // Additional data passed in
    ...data,
  };

  // Render the document
  doc.render(templateData);

  // Generate output
  const buf = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return buf;
}

/**
 * Generate both BAA and Service Agreement for a new client
 * @param {object} clientData - Client information
 * @returns {object} - { baa: Buffer, serviceAgreement: Buffer }
 */
export async function generateOnboardingDocuments(clientData) {
  const [baa, serviceAgreement] = await Promise.all([
    generateDocument('BAA', clientData),
    generateDocument('ServiceAgreement', clientData),
  ]);

  return {
    baa,
    serviceAgreement,
    baaFilename: `BAA_${clientData.pharmacyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`,
    serviceAgreementFilename: `ServiceAgreement_${clientData.pharmacyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`,
  };
}

/**
 * Generate full onboarding package (BAA, Service Agreement, Onboarding Guide)
 * @param {object} clientData - Client information
 * @returns {object} - All documents with filenames
 */
export async function generateOnboardingPackage(clientData) {
  const docs = await generateOnboardingDocuments(clientData);

  // Try to generate onboarding guide if template exists
  let onboardingGuide = null;
  let onboardingGuideFilename = null;

  const onboardingTemplatePath = path.join(rootDir, 'OnboardingGuide.docx');
  if (fs.existsSync(onboardingTemplatePath)) {
    try {
      onboardingGuide = await generateDocument('OnboardingGuide', clientData);
      onboardingGuideFilename = `OnboardingGuide_${clientData.pharmacyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`;
    } catch (err) {
      console.error('Failed to generate onboarding guide:', err.message);
    }
  }

  return {
    ...docs,
    onboardingGuide,
    onboardingGuideFilename,
  };
}

/**
 * PHI Data Fields for BAA Exhibit A
 * These are the fields TheRxOS accesses from pharmacy data
 */
export const PHI_DATA_FIELDS = [
  // Prescription Data
  { category: 'Prescription Data', field: 'Rx Number', description: 'Unique prescription identifier' },
  { category: 'Prescription Data', field: 'Date Written', description: 'Date prescription was written by prescriber' },
  { category: 'Prescription Data', field: 'DAW Code', description: 'Dispense As Written code' },
  { category: 'Prescription Data', field: 'Dispensed Item Name', description: 'Name of the medication dispensed' },
  { category: 'Prescription Data', field: 'Dispensed Item NDC', description: 'National Drug Code of dispensed medication' },
  { category: 'Prescription Data', field: 'Dispensed Quantity', description: 'Quantity of medication dispensed' },
  { category: 'Prescription Data', field: 'Dispensing Unit', description: 'Unit of measure for dispensed quantity' },
  { category: 'Prescription Data', field: 'Days Supply', description: 'Number of days the prescription will last' },
  { category: 'Prescription Data', field: 'Therapeutic Class Description', description: 'Drug classification category' },
  { category: 'Prescription Data', field: 'PDC', description: 'Proportion of Days Covered (adherence metric)' },
  // Financial Data
  { category: 'Financial Data', field: 'Dispensed AWP', description: 'Average Wholesale Price of dispensed medication' },
  { category: 'Financial Data', field: 'Net Profit', description: 'Pharmacy profit on the prescription' },
  { category: 'Financial Data', field: 'Patient Paid Amount', description: 'Amount paid by patient (copay/coinsurance)' },
  // Insurance/Payer Data
  { category: 'Insurance Data', field: 'Primary Contract ID', description: 'Insurance contract identifier' },
  { category: 'Insurance Data', field: 'Primary Prescription Benefit Plan', description: 'Name of prescription benefit plan' },
  { category: 'Insurance Data', field: 'Primary Third Party BIN', description: 'Bank Identification Number for claims processing' },
  { category: 'Insurance Data', field: 'Primary Group Number', description: 'Insurance group number' },
  { category: 'Insurance Data', field: 'Primary Network Reimbursement', description: 'Reimbursement amount from primary payer' },
  // Patient Data
  { category: 'Patient Data', field: 'Patient Full Name', description: 'Last name, First name' },
  { category: 'Patient Data', field: 'Patient Date of Birth', description: 'Patient date of birth' },
  { category: 'Patient Data', field: 'Patient Age', description: 'Calculated age of patient' },
  // Prescriber Data
  { category: 'Prescriber Data', field: 'Prescriber Full Name', description: 'Name of prescribing provider' },
  { category: 'Prescriber Data', field: 'Prescriber Fax Number', description: 'Fax number for prescriber communications' },
];

export default {
  generateDocument,
  generateOnboardingDocuments,
  generateOnboardingPackage,
  PHI_DATA_FIELDS,
};
