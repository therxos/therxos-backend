// Email Service for TheRxOS V2
// Sends welcome emails and other transactional emails

import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

let transporter = null;

/**
 * Initialize the email transporter
 * Tries Gmail OAuth first, falls back to SMTP
 */
async function getTransporter() {
  if (transporter) return transporter;

  // Try Gmail OAuth first (if configured)
  try {
    const tokenResult = await db.query(
      "SELECT token_data FROM system_settings WHERE setting_key = 'gmail_oauth_tokens'"
    );

    if (tokenResult.rows.length > 0 && process.env.GMAIL_CLIENT_ID) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback'
      );

      const tokenData = tokenResult.rows[0].token_data;
      const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
      oauth2Client.setCredentials(tokens);

      // Refresh if needed
      if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
        const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newTokens);
        await db.query(
          "UPDATE system_settings SET token_data = $1, updated_at = NOW() WHERE setting_key = 'gmail_oauth_tokens'",
          [JSON.stringify(newTokens)]
        );
      }

      const accessToken = await oauth2Client.getAccessToken();

      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: process.env.GMAIL_USER || 'stan@therxos.com',
          clientId: process.env.GMAIL_CLIENT_ID,
          clientSecret: process.env.GMAIL_CLIENT_SECRET,
          refreshToken: tokens.refresh_token,
          accessToken: accessToken.token,
        },
      });

      logger.info('Email transporter initialized with Gmail OAuth');
      return transporter;
    }
  } catch (err) {
    logger.warn('Gmail OAuth not available, trying SMTP fallback', { error: err.message });
  }

  // Fall back to SMTP if configured
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    logger.info('Email transporter initialized with SMTP');
    return transporter;
  }

  // No email configuration available
  logger.warn('No email configuration available - emails will be logged only');
  return null;
}

/**
 * Send welcome email to new client with credentials and documents
 * @param {object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.pharmacyName - Pharmacy/company name
 * @param {string} options.tempPassword - Temporary password
 * @param {Buffer} options.baaDocument - BAA document buffer
 * @param {string} options.baaFilename - BAA filename
 * @param {Buffer} options.serviceAgreement - Service Agreement buffer
 * @param {string} options.serviceAgreementFilename - Service Agreement filename
 */
export async function sendWelcomeEmail(options) {
  const {
    to,
    pharmacyName,
    tempPassword,
    baaDocument,
    baaFilename,
    serviceAgreement,
    serviceAgreementFilename,
  } = options;

  const loginUrl = 'https://beta.therxos.com/login';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #0d2137 0%, #1e3a5f 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { color: #14b8a6; margin: 0; font-size: 28px; }
    .content { background: #f8fafc; padding: 30px; border-radius: 0 0 8px 8px; }
    .credentials { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .credentials h3 { margin-top: 0; color: #0d2137; }
    .credential-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
    .credential-row:last-child { border-bottom: none; }
    .label { color: #64748b; }
    .value { font-family: monospace; color: #0d2137; font-weight: 600; }
    .button { display: inline-block; background: #14b8a6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .documents { background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .documents h3 { margin-top: 0; color: #92400e; }
    .footer { text-align: center; margin-top: 30px; color: #64748b; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>TheRxOS</h1>
      <p style="color: #94a3b8; margin: 10px 0 0 0;">Welcome to the Platform</p>
    </div>
    <div class="content">
      <p>Hi there,</p>
      <p>Welcome to <strong>TheRxOS</strong>! Your account for <strong>${pharmacyName}</strong> has been created and is ready for setup.</p>

      <div class="credentials">
        <h3>Your Login Credentials</h3>
        <div class="credential-row">
          <span class="label">Email/Username:</span>
          <span class="value">${to}</span>
        </div>
        <div class="credential-row">
          <span class="label">Temporary Password:</span>
          <span class="value">${tempPassword}</span>
        </div>
      </div>

      <p style="text-align: center;">
        <a href="${loginUrl}" class="button">Login to TheRxOS</a>
      </p>

      <div class="documents">
        <h3>Important Documents Attached</h3>
        <p style="margin-bottom: 0;">Please review and sign the attached documents:</p>
        <ul style="margin-top: 8px;">
          <li><strong>Business Associate Agreement (BAA)</strong> - Required for HIPAA compliance</li>
          <li><strong>Beta Service Agreement</strong> - Terms of service for the beta program</li>
        </ul>
        <p style="margin-bottom: 0; font-size: 14px;">You can sign these electronically and return them to <a href="mailto:stan@therxos.com">stan@therxos.com</a></p>
      </div>

      <h3>Next Steps</h3>
      <ol>
        <li>Log in using the credentials above</li>
        <li>Upload your prescription data (CSV or Excel file)</li>
        <li>We'll analyze your data and activate your full dashboard access</li>
        <li>Review and sign the attached agreements</li>
      </ol>

      <p>If you have any questions, just reply to this email or reach out to <a href="mailto:stan@therxos.com">stan@therxos.com</a>.</p>

      <p>Looking forward to helping ${pharmacyName} capture more clinical revenue!</p>

      <p>Best,<br><strong>Stan</strong><br>TheRxOS</p>
    </div>
    <div class="footer">
      <p>TheRxOS - The Rx Operating System<br>
      Helping independent pharmacies identify clinical opportunities</p>
    </div>
  </div>
</body>
</html>
  `;

  const textContent = `
Welcome to TheRxOS!

Your account for ${pharmacyName} has been created.

LOGIN CREDENTIALS
-----------------
Email/Username: ${to}
Temporary Password: ${tempPassword}

Login at: ${loginUrl}

IMPORTANT DOCUMENTS ATTACHED
----------------------------
Please review and sign the attached documents:
- Business Associate Agreement (BAA) - Required for HIPAA compliance
- Beta Service Agreement - Terms of service

You can sign these electronically and return them to stan@therxos.com

NEXT STEPS
----------
1. Log in using the credentials above
2. Upload your prescription data (CSV or Excel file)
3. We'll analyze your data and activate your full dashboard access
4. Review and sign the attached agreements

Questions? Reply to this email or contact stan@therxos.com

Best,
Stan
TheRxOS
  `;

  const mailOptions = {
    from: '"TheRxOS" <stan@therxos.com>',
    to,
    subject: `Welcome to TheRxOS - ${pharmacyName} Account Ready`,
    text: textContent,
    html: htmlContent,
    attachments: [],
  };

  // Add documents as attachments if provided
  if (baaDocument && baaFilename) {
    mailOptions.attachments.push({
      filename: baaFilename,
      content: baaDocument,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  if (serviceAgreement && serviceAgreementFilename) {
    mailOptions.attachments.push({
      filename: serviceAgreementFilename,
      content: serviceAgreement,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  // Try to send email
  const transport = await getTransporter();

  if (transport) {
    try {
      const result = await transport.sendMail(mailOptions);
      logger.info('Welcome email sent successfully', { to, pharmacyName, messageId: result.messageId });
      return { success: true, messageId: result.messageId };
    } catch (err) {
      logger.error('Failed to send welcome email', { to, pharmacyName, error: err.message });
      // Log credentials as fallback
      console.log('\n========== WELCOME EMAIL FAILED - MANUAL FOLLOW-UP NEEDED ==========');
      console.log(`To: ${to}`);
      console.log(`Pharmacy: ${pharmacyName}`);
      console.log(`Password: ${tempPassword}`);
      console.log('=====================================================================\n');
      return { success: false, error: err.message };
    }
  } else {
    // No email transport - log to console
    console.log('\n========== WELCOME EMAIL (NO TRANSPORT CONFIGURED) ==========');
    console.log(`To: ${to}`);
    console.log(`Pharmacy: ${pharmacyName}`);
    console.log(`Password: ${tempPassword}`);
    console.log(`Documents: BAA + Service Agreement generated`);
    console.log('==============================================================\n');
    return { success: false, error: 'No email transport configured' };
  }
}

export default {
  sendWelcomeEmail,
  getTransporter,
};
