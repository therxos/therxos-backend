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

export default {
  generateDocument,
  generateOnboardingDocuments,
};
