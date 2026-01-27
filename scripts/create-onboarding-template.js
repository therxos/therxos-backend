// Script to create OnboardingGuide.docx template
// Run with: node scripts/create-onboarding-template.js

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  CheckBox,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
} from 'docx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors
const TEAL = '14B8A6';
const DARK_BLUE = '0A1628';
const SLATE = '64748B';

// Helper to create a styled heading
function createHeading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    text,
    heading: level,
    spacing: { before: 400, after: 200 },
  });
}

// Helper to create body text
function createBody(text, options = {}) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        size: 24, // 12pt
        ...options,
      }),
    ],
    spacing: { after: 200 },
  });
}

// Helper to create a bullet point
function createBullet(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text, size: 24 })],
    bullet: { level },
    spacing: { after: 100 },
  });
}

// Create the document
const doc = new Document({
  styles: {
    default: {
      heading1: {
        run: {
          size: 48,
          bold: true,
          color: DARK_BLUE,
        },
        paragraph: {
          spacing: { before: 400, after: 200 },
        },
      },
      heading2: {
        run: {
          size: 36,
          bold: true,
          color: TEAL,
        },
        paragraph: {
          spacing: { before: 300, after: 150 },
        },
      },
      heading3: {
        run: {
          size: 28,
          bold: true,
          color: DARK_BLUE,
        },
        paragraph: {
          spacing: { before: 200, after: 100 },
        },
      },
    },
  },
  sections: [
    {
      properties: {},
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: 'TheRxOS',
                  bold: true,
                  size: 28,
                  color: TEAL,
                }),
                new TextRun({
                  text: ' | Onboarding Guide',
                  size: 24,
                  color: SLATE,
                }),
              ],
              alignment: AlignmentType.RIGHT,
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: 'TheRxOS - The Rx Operating System | ',
                  size: 20,
                  color: SLATE,
                }),
                new TextRun({
                  text: 'Page ',
                  size: 20,
                  color: SLATE,
                }),
                new TextRun({
                  children: [PageNumber.CURRENT],
                  size: 20,
                  color: SLATE,
                }),
              ],
              alignment: AlignmentType.CENTER,
            }),
          ],
        }),
      },
      children: [
        // Title
        new Paragraph({
          children: [
            new TextRun({
              text: 'Welcome to ',
              size: 56,
              bold: true,
            }),
            new TextRun({
              text: 'TheRxOS',
              size: 56,
              bold: true,
              color: TEAL,
            }),
          ],
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Onboarding Guide for {PHARMACY_NAME}',
              size: 32,
              color: SLATE,
            }),
          ],
          spacing: { after: 400 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Prepared: {DATE}',
              size: 24,
              italics: true,
              color: SLATE,
            }),
          ],
          spacing: { after: 600 },
        }),

        // Divider
        new Paragraph({
          border: {
            bottom: { color: TEAL, size: 12, style: BorderStyle.SINGLE },
          },
          spacing: { after: 400 },
        }),

        // What is TheRxOS
        createHeading('What is TheRxOS?', HeadingLevel.HEADING_1),
        createBody(
          'TheRxOS is a clinical opportunity management platform designed specifically for independent pharmacies. We scan your prescription claims data to identify revenue opportunities that are often missed in the day-to-day workflow.'
        ),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Our platform identifies:',
              size: 24,
              bold: true,
            }),
          ],
          spacing: { before: 200, after: 100 },
        }),
        createBullet('Therapeutic Interchange Opportunities - Switch to preferred formulary alternatives with better reimbursement'),
        createBullet('Missing Therapy Opportunities - Identify patients who may benefit from additional guideline-recommended therapies'),
        createBullet('Optimization Opportunities - Improve adherence, find covered alternatives, and maximize clinical outcomes'),
        createBody(
          'Each opportunity is tracked from identification through prescriber approval, helping you capture additional revenue while improving patient care.'
        ),

        // Onboarding Checklist
        createHeading('Onboarding Checklist', HeadingLevel.HEADING_1),

        createHeading('Step 1: Sign Agreements', HeadingLevel.HEADING_2),
        createBody('Please review and sign the following documents:'),
        new Paragraph({
          children: [
            new TextRun({ text: '☐  ', size: 24 }),
            new TextRun({ text: 'Business Associate Agreement (BAA)', size: 24, bold: true }),
            new TextRun({ text: ' - Required for HIPAA compliance', size: 24 }),
          ],
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: '☐  ', size: 24 }),
            new TextRun({ text: 'Service Agreement', size: 24, bold: true }),
            new TextRun({ text: ' - Terms of service and subscription', size: 24 }),
          ],
          spacing: { after: 200 },
        }),

        createHeading('Step 2: Provide Data Export', HeadingLevel.HEADING_2),
        createBody('We need a prescription data export from your pharmacy management system. The export should include the following fields:'),

        // Data Fields Table
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            // Header row
            new TableRow({
              tableHeader: true,
              children: [
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'Field', bold: true, size: 22 })] })],
                  shading: { fill: TEAL, type: ShadingType.SOLID },
                  width: { size: 35, type: WidthType.PERCENTAGE },
                }),
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'Description', bold: true, size: 22 })] })],
                  shading: { fill: TEAL, type: ShadingType.SOLID },
                  width: { size: 65, type: WidthType.PERCENTAGE },
                }),
              ],
            }),
            // Data rows
            ...([
              ['Rx Number', 'Unique prescription identifier'],
              ['Patient Full Name', 'Last, First format'],
              ['Patient Date of Birth', 'MM/DD/YYYY format'],
              ['Patient Age', 'Calculated age'],
              ['Date Written', 'Date prescription was written'],
              ['DAW Code', 'Dispense As Written code'],
              ['Dispensed Item Name', 'Medication name as dispensed'],
              ['Dispensed Item NDC', '11-digit National Drug Code'],
              ['Dispensed Quantity', 'Amount dispensed'],
              ['Dispensing Unit', 'Unit of measure (EA, ML, etc.)'],
              ['Days Supply', 'Number of days medication will last'],
              ['Therapeutic Class', 'Drug classification category'],
              ['PDC', 'Proportion of Days Covered (if available)'],
              ['Dispensed AWP', 'Average Wholesale Price'],
              ['Net Profit', 'Pharmacy profit per Rx'],
              ['Patient Paid Amount', 'Copay/coinsurance amount'],
              ['Primary Contract ID', 'Insurance contract identifier'],
              ['Primary Benefit Plan', 'Prescription benefit plan name'],
              ['Primary BIN', 'Bank Identification Number'],
              ['Primary Group Number', 'Insurance group number'],
              ['Primary Reimbursement', 'Amount paid by primary payer'],
              ['Prescriber Full Name', 'Prescriber name'],
              ['Prescriber Fax Number', 'For sending change requests'],
            ]).map(([field, desc]) =>
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: field, size: 20 })] })],
                  }),
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: desc, size: 20 })] })],
                  }),
                ],
              })
            ),
          ],
        }),

        new Paragraph({ spacing: { after: 200 } }),

        createHeading('Export Instructions by PMS', HeadingLevel.HEADING_3),
        createBullet('PioneerRx: Reports > Custom Reports > Claims Export'),
        createBullet('Rx30: Reports > Third Party > Claims History Export'),
        createBullet('Liberty: Analytics > Export > Claims Data'),
        createBullet('PharmSoft: Reports > Insurance > Claims Report'),
        createBullet('Other: Contact us for specific instructions'),

        createHeading('Step 3: Account Setup', HeadingLevel.HEADING_2),
        createBody('Once we process your data, you will receive:'),
        createBullet('Login credentials for beta.therxos.com'),
        createBullet('Initial opportunity report showing your potential revenue'),
        createBullet('Training session scheduling link (30 minutes)'),

        // What Happens Next
        createHeading('What Happens Next', HeadingLevel.HEADING_1),

        new Paragraph({
          children: [
            new TextRun({ text: '1. Data Processing', size: 28, bold: true, color: TEAL }),
            new TextRun({ text: ' (1-2 business days)', size: 24 }),
          ],
          spacing: { before: 200, after: 100 },
        }),
        createBullet('We securely import and analyze your prescription data'),
        createBullet('Identify all clinical opportunities based on current guidelines'),
        createBullet('Calculate potential revenue impact'),

        new Paragraph({
          children: [
            new TextRun({ text: '2. Review Call', size: 28, bold: true, color: TEAL }),
            new TextRun({ text: ' (30 minutes)', size: 24 }),
          ],
          spacing: { before: 200, after: 100 },
        }),
        createBullet('Walk through your personalized opportunity dashboard'),
        createBullet('Customize trigger settings for your patient population'),
        createBullet('Train your team on the workflow'),

        new Paragraph({
          children: [
            new TextRun({ text: '3. Go Live', size: 28, bold: true, color: TEAL }),
          ],
          spacing: { before: 200, after: 100 },
        }),
        createBullet('Start working opportunities immediately'),
        createBullet('Track submissions and prescriber approvals'),
        createBullet('Monitor revenue capture in real-time'),

        // Subscription Details
        createHeading('Subscription Details', HeadingLevel.HEADING_1),
        new Paragraph({
          children: [
            new TextRun({ text: 'Monthly Subscription: ', size: 28 }),
            new TextRun({ text: '$599/month', size: 32, bold: true, color: TEAL }),
          ],
          spacing: { after: 200 },
        }),
        createBody('Includes:'),
        createBullet('Unlimited opportunities identified'),
        createBullet('Unlimited team member accounts'),
        createBullet('Email and phone support'),
        createBullet('Monthly performance reports'),
        createBullet('Formulary and coverage updates'),

        // FAQ
        createHeading('Frequently Asked Questions', HeadingLevel.HEADING_1),

        new Paragraph({
          children: [new TextRun({ text: 'How often should I send data exports?', size: 24, bold: true })],
          spacing: { before: 200, after: 50 },
        }),
        createBody('We recommend weekly exports for optimal opportunity identification. You can upload directly through the dashboard or set up automated exports.'),

        new Paragraph({
          children: [new TextRun({ text: 'Is my patient data secure?', size: 24, bold: true })],
          spacing: { before: 200, after: 50 },
        }),
        createBody('Yes. All data is encrypted in transit (TLS 1.2+) and at rest (AES-256). We maintain SOC 2 Type II compliance and sign a Business Associate Agreement with every pharmacy.'),

        new Paragraph({
          children: [new TextRun({ text: 'How long until I see ROI?', size: 24, bold: true })],
          spacing: { before: 200, after: 50 },
        }),
        createBody('Most pharmacies see their first approved opportunities within the first week. Average ROI is 10-20x the monthly subscription cost.'),

        new Paragraph({
          children: [new TextRun({ text: 'Can I customize which opportunities I see?', size: 24, bold: true })],
          spacing: { before: 200, after: 50 },
        }),
        createBody('Absolutely. You have full control over which trigger types are active for your pharmacy. You can enable/disable specific therapeutic interchanges based on your preferences.'),

        // Contact
        createHeading('Contact Information', HeadingLevel.HEADING_1),
        new Paragraph({
          children: [
            new TextRun({ text: 'Email: ', size: 24, bold: true }),
            new TextRun({ text: 'support@therxos.com', size: 24, color: TEAL }),
          ],
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Website: ', size: 24, bold: true }),
            new TextRun({ text: 'beta.therxos.com', size: 24, color: TEAL }),
          ],
          spacing: { after: 300 },
        }),

        new Paragraph({
          children: [
            new TextRun({ text: 'Your Account Manager:', size: 24, bold: true }),
          ],
          spacing: { after: 50 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Stan - "Pharmacy Stan"', size: 24 }),
          ],
          spacing: { after: 50 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: '23 years pharmacy experience', size: 22, italics: true, color: SLATE }),
          ],
          spacing: { after: 400 },
        }),

        // Footer tagline
        new Paragraph({
          border: {
            top: { color: TEAL, size: 12, style: BorderStyle.SINGLE },
          },
          spacing: { before: 400 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'TheRxOS', size: 28, bold: true, color: TEAL }),
            new TextRun({ text: ' - The Rx Operating System', size: 28, bold: true }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 50 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Turning clinical data into pharmacy revenue', size: 24, italics: true, color: SLATE }),
          ],
          alignment: AlignmentType.CENTER,
        }),
      ],
    },
  ],
});

// Generate and save the document
const outputPath = path.join(__dirname, '..', 'OnboardingGuide.docx');

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outputPath, buffer);
  console.log(`OnboardingGuide.docx created at: ${outputPath}`);
}).catch((err) => {
  console.error('Error creating document:', err);
});
