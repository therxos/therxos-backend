// Fax Document Generator - Creates PDF fax documents for prescribers
// Uses pdfkit to generate professional fax cover sheets with clinical recommendations

import PDFDocument from 'pdfkit';
import { formatPatientName, formatPrescriberName, formatDrugName } from '../utils/formatters.js';

/**
 * Generate a fax PDF document for a therapeutic recommendation
 * @param {Object} options
 * @param {Object} options.pharmacy - { pharmacy_name, address, city, state, zip, phone, fax, npi }
 * @param {Object} options.prescriber - { name, npi, fax_number }
 * @param {Object} options.patient - { first_name, last_name, date_of_birth }
 * @param {Object} options.opportunity - { current_drug_name, recommended_drug_name, opportunity_type, clinical_rationale }
 * @returns {Promise<Buffer>} PDF buffer ready for faxing
 */
export async function generateFaxDocument(options) {
  const { pharmacy, prescriber, patient, opportunity } = options;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: 50,
        info: {
          Title: `Therapeutic Recommendation - ${formatPatientName(patient.first_name, patient.last_name)}`,
          Author: pharmacy.pharmacy_name || 'TheRxOS',
        }
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - 100; // 50px margin each side

      // === PHARMACY HEADER ===
      doc.fontSize(16).font('Helvetica-Bold')
        .text(pharmacy.pharmacy_name || 'Pharmacy', 50, 50);

      doc.fontSize(9).font('Helvetica');
      let headerY = 70;

      if (pharmacy.address) {
        doc.text(pharmacy.address, 50, headerY);
        headerY += 12;
      }
      if (pharmacy.city || pharmacy.state || pharmacy.zip) {
        doc.text(`${pharmacy.city || ''}, ${pharmacy.state || ''} ${pharmacy.zip || ''}`.trim(), 50, headerY);
        headerY += 12;
      }

      const contactParts = [];
      if (pharmacy.phone) contactParts.push(`Phone: ${pharmacy.phone}`);
      if (pharmacy.fax) contactParts.push(`Fax: ${pharmacy.fax}`);
      if (contactParts.length > 0) {
        doc.text(contactParts.join('   |   '), 50, headerY);
        headerY += 12;
      }
      if (pharmacy.npi) {
        doc.text(`NPI: ${pharmacy.npi}`, 50, headerY);
        headerY += 12;
      }

      // Date on the right
      const dateStr = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
      doc.fontSize(10).text(dateStr, 50, 50, { align: 'right', width: pageWidth });

      // Divider
      headerY += 8;
      doc.moveTo(50, headerY).lineTo(50 + pageWidth, headerY).lineWidth(1).stroke();
      headerY += 15;

      // === PRESCRIBER BLOCK ===
      doc.fontSize(10).font('Helvetica-Bold').text('TO:', 50, headerY);
      doc.font('Helvetica');

      const formattedPrescriberName = formatPrescriberName(prescriber.name);
      doc.text(`    ${formattedPrescriberName}`, 75, headerY);
      headerY += 15;

      if (prescriber.npi) {
        doc.text(`    NPI: ${prescriber.npi}`, 75, headerY);
        headerY += 15;
      }
      if (prescriber.fax_number) {
        doc.text(`    Fax: ${prescriber.fax_number}`, 75, headerY);
        headerY += 15;
      }

      // Divider
      headerY += 5;
      doc.moveTo(50, headerY).lineTo(50 + pageWidth, headerY).lineWidth(0.5).stroke();
      headerY += 15;

      // === RE: LINE ===
      const isAddOn = ['missing_therapy', 'combo_therapy'].includes(opportunity.opportunity_type);
      const reTitle = isAddOn ? 'THERAPEUTIC RECOMMENDATION — ADD THERAPY' : 'THERAPEUTIC RECOMMENDATION';

      doc.fontSize(13).font('Helvetica-Bold').text(reTitle, 50, headerY);
      headerY += 25;

      // === PATIENT INFO ===
      const patientName = formatPatientName(patient.first_name, patient.last_name);
      const dobFormatted = patient.date_of_birth
        ? new Date(patient.date_of_birth).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
        : 'N/A';

      doc.fontSize(10).font('Helvetica-Bold').text('Patient: ', 50, headerY, { continued: true });
      doc.font('Helvetica').text(`${patientName}        DOB: ${dobFormatted}`);
      headerY += 25;

      // === CURRENT THERAPY ===
      doc.font('Helvetica-Bold').text('Current Therapy:', 50, headerY);
      headerY += 15;
      doc.font('Helvetica').fontSize(11)
        .text(`    ${formatDrugName(opportunity.current_drug_name) || 'N/A'}`, 50, headerY);
      headerY += 25;

      // === RECOMMENDED ===
      const recLabel = isAddOn ? 'Recommended Addition:' : 'Recommended Alternative:';
      doc.fontSize(10).font('Helvetica-Bold').text(recLabel, 50, headerY);
      headerY += 15;
      doc.font('Helvetica').fontSize(11)
        .text(`    ${formatDrugName(opportunity.recommended_drug_name) || 'N/A'}`, 50, headerY);
      headerY += 25;

      // === CLINICAL RATIONALE ===
      if (opportunity.clinical_rationale) {
        doc.fontSize(10).font('Helvetica-Bold').text('Clinical Rationale:', 50, headerY);
        headerY += 15;
        doc.font('Helvetica').fontSize(10)
          .text(opportunity.clinical_rationale, 70, headerY, {
            width: pageWidth - 20,
            lineGap: 3
          });
        headerY = doc.y + 25;
      }

      // Divider
      doc.moveTo(50, headerY).lineTo(50 + pageWidth, headerY).lineWidth(1).stroke();
      headerY += 15;

      // === PRESCRIBER RESPONSE SECTION ===
      doc.fontSize(12).font('Helvetica-Bold').text('PRESCRIBER RESPONSE', 50, headerY);
      headerY += 25;

      doc.fontSize(10).font('Helvetica');

      // Checkboxes
      const checkboxOptions = isAddOn
        ? [
            'APPROVE — Add recommended therapy',
            'DECLINE — Do not add therapy',
            'OTHER: _______________________________________________'
          ]
        : [
            'APPROVE — Change to recommended alternative',
            'CONTINUE — Maintain current therapy',
            'OTHER: _______________________________________________'
          ];

      for (const option of checkboxOptions) {
        // Draw checkbox
        doc.rect(70, headerY - 1, 10, 10).lineWidth(0.5).stroke();
        doc.text(`    ${option}`, 85, headerY, { width: pageWidth - 55 });
        headerY += 22;
      }

      headerY += 15;

      // Signature line
      doc.text('Prescriber Signature: ', 50, headerY, { continued: true });
      doc.text('_'.repeat(50));
      headerY += 20;
      doc.text('Date: ____/____/________', 50, headerY);
      headerY += 30;

      // Divider
      doc.moveTo(50, headerY).lineTo(50 + pageWidth, headerY).lineWidth(0.5).stroke();
      headerY += 15;

      // === FOOTER ===
      doc.fontSize(9).font('Helvetica-Bold');
      if (pharmacy.fax) {
        doc.text(`Please fax response to: ${pharmacy.fax}`, 50, headerY);
        headerY += 13;
      }
      if (pharmacy.phone) {
        doc.text(`Questions? Call: ${pharmacy.phone}`, 50, headerY);
        headerY += 20;
      }

      // Confidentiality notice
      doc.fontSize(7).font('Helvetica')
        .text(
          'CONFIDENTIALITY NOTICE: This facsimile transmission contains protected health information (PHI) ' +
          'and is intended only for the named recipient. If you have received this fax in error, please notify ' +
          'the sender immediately and destroy all copies. Unauthorized disclosure of PHI is prohibited by law.',
          50, headerY,
          { width: pageWidth, lineGap: 2 }
        );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export default { generateFaxDocument };
