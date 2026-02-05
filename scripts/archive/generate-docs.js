// Generate TheRxOS documentation PDFs
// Run with: node generate-docs.js

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

// Brand colors
const NAVY = '#1e3a5f';
const TEAL = '#14b8a6';
const DARK_BG = '#0a1628';
const WHITE = '#ffffff';
const GRAY = '#64748b';

// Helper to draw header
function drawHeader(doc, title, subtitle) {
  // Navy header bar
  doc.rect(0, 0, 612, 100).fill(NAVY);

  // Logo text
  doc.fillColor(WHITE)
     .font('Helvetica-Bold')
     .fontSize(28)
     .text('TheRxOS', 50, 30);

  doc.fillColor(TEAL)
     .font('Helvetica')
     .fontSize(12)
     .text('The Rx Operating System', 50, 62);

  // Title
  doc.fillColor(WHITE)
     .font('Helvetica-Bold')
     .fontSize(16)
     .text(title, 300, 35, { align: 'right', width: 262 });

  if (subtitle) {
    doc.fillColor(TEAL)
       .font('Helvetica')
       .fontSize(10)
       .text(subtitle, 300, 58, { align: 'right', width: 262 });
  }
}

// Helper to draw section header
function sectionHeader(doc, text, y) {
  doc.rect(50, y, 512, 25).fill(NAVY);
  doc.fillColor(WHITE)
     .font('Helvetica-Bold')
     .fontSize(12)
     .text(text, 60, y + 7);
  return y + 35;
}

// Helper for body text
function bodyText(doc, text, y, options = {}) {
  doc.fillColor(options.color || '#333333')
     .font(options.font || 'Helvetica')
     .fontSize(options.size || 11)
     .text(text, 50, y, { width: 512, ...options });
  return doc.y + 10;
}

// Helper for bullet points
function bulletPoint(doc, text, y) {
  doc.fillColor(TEAL)
     .font('Helvetica-Bold')
     .fontSize(11)
     .text('•', 55, y);
  doc.fillColor('#333333')
     .font('Helvetica')
     .text(text, 70, y, { width: 490 });
  return doc.y + 5;
}

// ============================================
// 1. CLIENT ONBOARDING DOCUMENT
// ============================================
function generateClientOnboarding() {
  const doc = new PDFDocument({ size: 'letter', margin: 50 });
  const stream = fs.createWriteStream('TheRxOS_Client_Onboarding_Guide.pdf');
  doc.pipe(stream);

  drawHeader(doc, 'Client Onboarding Guide', 'Welcome to TheRxOS');

  let y = 120;

  // Welcome
  y = bodyText(doc, 'Welcome to TheRxOS! This guide will walk you through the onboarding process to get your pharmacy up and running with our clinical opportunity platform.', y, { size: 12 });
  y += 10;

  // Step 1
  y = sectionHeader(doc, 'Step 1: Data Export from Your Pharmacy System', y);
  y = bodyText(doc, 'Export your prescription data from your pharmacy management system. We support multiple formats:', y);
  y = bulletPoint(doc, 'PioneerRx: Use the "Prescription Detail" report with all columns', y);
  y = bulletPoint(doc, 'RX30: Export the standard claims report (we handle Azure encryption)', y);
  y = bulletPoint(doc, 'PrimeRx: Contact us for specific export instructions', y);
  y = bulletPoint(doc, 'Other systems: CSV export with patient, drug, prescriber, and insurance data', y);
  y += 10;

  // Step 2
  y = sectionHeader(doc, 'Step 2: Secure Data Upload', y);
  y = bodyText(doc, 'Your TheRxOS administrator will securely upload your data to our HIPAA-compliant platform. All data is encrypted in transit and at rest.', y);
  y += 10;

  // Step 3
  y = sectionHeader(doc, 'Step 3: Opportunity Scanning', y);
  y = bodyText(doc, 'Our system automatically scans your prescription data against 70+ clinical triggers to identify:', y);
  y = bulletPoint(doc, 'Therapeutic interchange opportunities (brand to generic, formulary optimization)', y);
  y = bulletPoint(doc, 'Missing therapy opportunities (glucagon for insulin users, etc.)', y);
  y = bulletPoint(doc, 'OTC optimization (lancets, pen needles, test strips)', y);
  y = bulletPoint(doc, 'Clinical interventions with GP improvement potential', y);
  y += 10;

  // Step 4
  y = sectionHeader(doc, 'Step 4: Account Setup', y);
  y = bodyText(doc, 'You will receive login credentials for your pharmacy dashboard at beta.therxos.com. Your account includes:', y);
  y = bulletPoint(doc, 'Owner/Admin access with full permissions', y);
  y = bulletPoint(doc, 'Ability to create staff accounts with role-based permissions', y);
  y = bulletPoint(doc, 'Pharmacist and Technician roles for your team', y);
  y += 10;

  // Step 5
  y = sectionHeader(doc, 'Step 5: Working Opportunities', y);
  y = bodyText(doc, 'Once logged in, you can:', y);
  y = bulletPoint(doc, 'View all opportunities sorted by potential value', y);
  y = bulletPoint(doc, 'Group opportunities by patient or prescriber', y);
  y = bulletPoint(doc, 'Generate professional fax forms for prescriber outreach', y);
  y = bulletPoint(doc, 'Track status from submission through approval', y);
  y = bulletPoint(doc, 'Monitor monthly performance and ROI', y);

  // New page for support
  doc.addPage();
  drawHeader(doc, 'Client Onboarding Guide', 'Support & Resources');

  y = 120;
  y = sectionHeader(doc, 'Ongoing Support', y);
  y = bodyText(doc, 'TheRxOS provides continuous support to ensure your success:', y);
  y = bulletPoint(doc, 'Regular data refreshes to identify new opportunities', y);
  y = bulletPoint(doc, 'Trigger updates as formularies and clinical guidelines change', y);
  y = bulletPoint(doc, 'Direct support from Pharmacy Stan with 23+ years of pharmacy experience', y);
  y += 10;

  y = sectionHeader(doc, 'Best Practices', y);
  y = bulletPoint(doc, 'Review opportunities weekly and prioritize high-value items', y);
  y = bulletPoint(doc, 'Batch faxes by prescriber to maximize efficiency', y);
  y = bulletPoint(doc, 'Update opportunity status promptly for accurate reporting', y);
  y = bulletPoint(doc, 'Use the notes feature to track prescriber preferences', y);
  y += 10;

  y = sectionHeader(doc, 'Contact Information', y);
  y = bodyText(doc, 'For support or questions:', y);
  y = bulletPoint(doc, 'Email: stan@therxos.com', y);
  y = bulletPoint(doc, 'Platform: beta.therxos.com', y);
  y += 20;

  // Footer
  doc.fillColor(GRAY)
     .font('Helvetica')
     .fontSize(9)
     .text('TheRxOS - Empowering Independent Pharmacies', 50, 700, { align: 'center', width: 512 });
  doc.text('© 2026 TheRxOS. All rights reserved.', 50, 715, { align: 'center', width: 512 });

  doc.end();
  console.log('Generated: TheRxOS_Client_Onboarding_Guide.pdf');
}

// ============================================
// 2. PRESCRIBER INFORMATION DOCUMENT
// ============================================
function generatePrescriberInfo() {
  const doc = new PDFDocument({ size: 'letter', margin: 50 });
  const stream = fs.createWriteStream('TheRxOS_Prescriber_Information.pdf');
  doc.pipe(stream);

  drawHeader(doc, 'Prescriber Information', 'Therapeutic Interchange Program');

  let y = 120;

  // Intro
  y = bodyText(doc, 'Your local independent pharmacy is participating in a clinical optimization program to improve patient outcomes and reduce medication costs. This document explains what to expect.', y, { size: 12 });
  y += 15;

  // What is this?
  y = sectionHeader(doc, 'What is Therapeutic Interchange?', y);
  y = bodyText(doc, 'Therapeutic interchange is the practice of dispensing a medication that is therapeutically equivalent but chemically different from the originally prescribed medication. This is done with prescriber authorization to:', y);
  y = bulletPoint(doc, 'Improve formulary compliance and reduce patient out-of-pocket costs', y);
  y = bulletPoint(doc, 'Switch to medications with better clinical outcomes or safety profiles', y);
  y = bulletPoint(doc, 'Optimize therapy based on current clinical guidelines', y);
  y += 10;

  // What to expect
  y = sectionHeader(doc, 'What to Expect', y);
  y = bodyText(doc, 'You may receive fax requests from your patients\' pharmacy with:', y);
  y = bulletPoint(doc, 'Current medication and recommended therapeutic alternative', y);
  y = bulletPoint(doc, 'Clinical rationale for the recommended change', y);
  y = bulletPoint(doc, 'Simple response form (Approve/Deny with signature)', y);
  y += 5;
  y = bodyText(doc, 'Each request is reviewed by a licensed pharmacist before being sent to ensure clinical appropriateness.', y);
  y += 10;

  // Benefits
  y = sectionHeader(doc, 'Benefits for Your Patients', y);
  y = bulletPoint(doc, 'Lower copays and out-of-pocket medication costs', y);
  y = bulletPoint(doc, 'Improved adherence through affordable therapy', y);
  y = bulletPoint(doc, 'Access to clinically equivalent or superior alternatives', y);
  y = bulletPoint(doc, 'Proactive identification of missing therapies (e.g., glucagon for insulin users)', y);
  y += 10;

  // Clinical review
  y = sectionHeader(doc, 'Clinical Oversight', y);
  y = bodyText(doc, 'All therapeutic interchange recommendations are:', y);
  y = bulletPoint(doc, 'Based on current clinical guidelines and formulary data', y);
  y = bulletPoint(doc, 'Reviewed by a licensed pharmacist before outreach', y);
  y = bulletPoint(doc, 'Documented with clinical justification', y);
  y = bulletPoint(doc, 'Subject to your final approval - you maintain full prescribing authority', y);

  // New page
  doc.addPage();
  drawHeader(doc, 'Prescriber Information', 'How to Respond');

  y = 120;
  y = sectionHeader(doc, 'Responding to Requests', y);
  y = bodyText(doc, 'When you receive a Therapeutic Interchange Request Form:', y);
  y += 5;
  y = bulletPoint(doc, 'Review the current medication and recommended alternative', y);
  y = bulletPoint(doc, 'Check the clinical rationale provided', y);
  y = bulletPoint(doc, 'Mark APPROVED or DENIED on the response section', y);
  y = bulletPoint(doc, 'Sign and date the form', y);
  y = bulletPoint(doc, 'Fax back to the pharmacy at the number provided', y);
  y += 10;

  y = bodyText(doc, 'If you have questions about a specific recommendation, contact the pharmacy directly - they are happy to discuss the clinical rationale.', y);
  y += 15;

  y = sectionHeader(doc, 'Common Interchange Categories', y);
  y = bulletPoint(doc, 'Brand to Generic: Clinically equivalent generic alternatives', y);
  y = bulletPoint(doc, 'Formulary Optimization: Preferred formulary medications', y);
  y = bulletPoint(doc, 'Therapeutic Alternatives: Different drug class with similar efficacy', y);
  y = bulletPoint(doc, 'Missing Therapy: Recommended additions based on current medications', y);
  y += 15;

  // Contact placeholder
  y = sectionHeader(doc, 'Pharmacy Contact Information', y);
  doc.rect(50, y, 512, 80).stroke(NAVY);
  doc.fillColor(GRAY)
     .font('Helvetica-Oblique')
     .fontSize(10)
     .text('Pharmacy Name: _________________________________', 60, y + 15)
     .text('Phone: _________________________________', 60, y + 35)
     .text('Fax: _________________________________', 60, y + 55)
     .text('Contact Person: _________________________________', 310, y + 15)
     .text('NPI: _________________________________', 310, y + 35);

  y += 100;

  // Footer
  doc.fillColor(GRAY)
     .font('Helvetica')
     .fontSize(9)
     .text('This program is operated in partnership with TheRxOS - Empowering Independent Pharmacies', 50, 700, { align: 'center', width: 512 });

  doc.end();
  console.log('Generated: TheRxOS_Prescriber_Information.pdf');
}

// ============================================
// 3. DEMO VIDEO INSTRUCTIONS
// ============================================
function generateDemoVideoInstructions() {
  const doc = new PDFDocument({ size: 'letter', margin: 50 });
  const stream = fs.createWriteStream('TheRxOS_Demo_Video_Instructions.pdf');
  doc.pipe(stream);

  drawHeader(doc, 'Demo Video Creation Guide', 'Tools & Instructions');

  let y = 120;

  y = bodyText(doc, 'This guide outlines options for creating a professional demo video for TheRxOS. Choose the approach that best fits your budget and timeline.', y, { size: 12 });
  y += 15;

  // Option 1
  y = sectionHeader(doc, 'Option 1: Screen Recording (Quickest)', y);
  y = bodyText(doc, 'Best for: Quick turnaround, authentic product demo', y, { font: 'Helvetica-Bold' });
  y = bodyText(doc, 'Tools needed:', y);
  y = bulletPoint(doc, 'Loom (free) - loom.com - Easy screen + camera recording', y);
  y = bulletPoint(doc, 'OBS Studio (free) - obsproject.com - Professional screen capture', y);
  y = bulletPoint(doc, 'Camtasia ($300) - techsmith.com - Screen recording + editing', y);
  y += 5;
  y = bodyText(doc, 'Steps:', y);
  y = bulletPoint(doc, 'Log into Hero Pharmacy demo account', y);
  y = bulletPoint(doc, 'Record a walkthrough of key features (dashboard, opportunities, fax generation)', y);
  y = bulletPoint(doc, 'Add voiceover explaining the value proposition', y);
  y = bulletPoint(doc, 'Keep it under 3 minutes for engagement', y);
  y += 10;

  // Option 2
  y = sectionHeader(doc, 'Option 2: AI-Generated Video (Modern)', y);
  y = bodyText(doc, 'Best for: Professional look without on-camera presence', y, { font: 'Helvetica-Bold' });
  y = bodyText(doc, 'Tools needed:', y);
  y = bulletPoint(doc, 'Synthesia (synthesia.io) - AI avatars, $30/month', y);
  y = bulletPoint(doc, 'HeyGen (heygen.com) - AI spokesperson, $24/month', y);
  y = bulletPoint(doc, 'Pictory (pictory.ai) - Script to video, $23/month', y);
  y += 5;
  y = bodyText(doc, 'Steps:', y);
  y = bulletPoint(doc, 'Write a script covering: problem, solution, demo highlights, call to action', y);
  y = bulletPoint(doc, 'Upload script to AI video tool', y);
  y = bulletPoint(doc, 'Select a professional avatar/presenter', y);
  y = bulletPoint(doc, 'Add screen recordings of the platform as B-roll', y);
  y = bulletPoint(doc, 'Export and host on YouTube/Vimeo', y);

  // New page
  doc.addPage();
  drawHeader(doc, 'Demo Video Creation Guide', 'More Options');

  y = 120;

  // Option 3
  y = sectionHeader(doc, 'Option 3: Animated Explainer (Premium)', y);
  y = bodyText(doc, 'Best for: Polished marketing video, longer shelf life', y, { font: 'Helvetica-Bold' });
  y = bodyText(doc, 'Tools needed:', y);
  y = bulletPoint(doc, 'Vyond (vyond.com) - Animated videos, $49/month', y);
  y = bulletPoint(doc, 'Animaker (animaker.com) - Animation + live action, $20/month', y);
  y = bulletPoint(doc, 'Powtoon (powtoon.com) - Animated presentations, $20/month', y);
  y += 5;
  y = bodyText(doc, 'Steps:', y);
  y = bulletPoint(doc, 'Storyboard the video: problem → solution → features → results → CTA', y);
  y = bulletPoint(doc, 'Create animated scenes for each section', y);
  y = bulletPoint(doc, 'Add voiceover (use ElevenLabs.io for AI voice if needed)', y);
  y = bulletPoint(doc, 'Include actual product screenshots as overlays', y);
  y += 10;

  // Option 4
  y = sectionHeader(doc, 'Option 4: Hire a Professional (Best Quality)', y);
  y = bodyText(doc, 'Best for: High-quality result if budget allows', y, { font: 'Helvetica-Bold' });
  y = bulletPoint(doc, 'Fiverr - Search "SaaS demo video" - $100-500 range', y);
  y = bulletPoint(doc, 'Upwork - Hire a video editor - $200-1000 range', y);
  y = bulletPoint(doc, 'Local videographer - $500-2000 for professional production', y);
  y += 15;

  // Recommended script outline
  y = sectionHeader(doc, 'Recommended Video Script Outline', y);
  y = bulletPoint(doc, '0:00-0:15 - Hook: "Independent pharmacies leave $50K+ on the table annually..."', y);
  y = bulletPoint(doc, '0:15-0:45 - Problem: Manual opportunity tracking, missed clinical interventions', y);
  y = bulletPoint(doc, '0:45-1:30 - Solution: TheRxOS automatically scans and identifies opportunities', y);
  y = bulletPoint(doc, '1:30-2:15 - Demo: Quick walkthrough of dashboard, opportunities, fax generation', y);
  y = bulletPoint(doc, '2:15-2:45 - Results: "Pharmacies see $X in recovered margin within 30 days"', y);
  y = bulletPoint(doc, '2:45-3:00 - CTA: "Schedule a demo at therxos.com"', y);
  y += 15;

  // Tips
  y = sectionHeader(doc, 'Pro Tips', y);
  y = bulletPoint(doc, 'Use the Hero Pharmacy demo data for all recordings (Marvel character names)', y);
  y = bulletPoint(doc, 'Keep total length under 3 minutes - attention spans are short', y);
  y = bulletPoint(doc, 'Include real dollar amounts to make the value concrete', y);
  y = bulletPoint(doc, 'End with a clear call to action and contact info', y);

  // Footer
  doc.fillColor(GRAY)
     .font('Helvetica')
     .fontSize(9)
     .text('TheRxOS - Empowering Independent Pharmacies', 50, 700, { align: 'center', width: 512 });

  doc.end();
  console.log('Generated: TheRxOS_Demo_Video_Instructions.pdf');
}

// Run all generators
console.log('Generating TheRxOS documentation PDFs...\n');
generateClientOnboarding();
generatePrescriberInfo();
generateDemoVideoInstructions();
console.log('\nAll PDFs generated in current directory.');
