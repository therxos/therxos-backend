// auto-capture-gmail.js
// Polls Gmail for PioneerRx captured opportunity notifications
// Updates opportunity statuses automatically based on email confirmations
//
// Setup:
// 1. Enable Gmail API in Google Cloud Console
// 2. Create OAuth2 credentials (Desktop app)
// 3. Download credentials.json to this directory
// 4. Run: node auto-capture-gmail.js --setup (first time only)
// 5. Run: node auto-capture-gmail.js (normal polling)
//
// Environment variables needed:
// - DATABASE_URL: Supabase connection string
// - GMAIL_CLIENT_ID: From Google Cloud Console
// - GMAIL_CLIENT_SECRET: From Google Cloud Console
// - GMAIL_REFRESH_TOKEN: Generated during setup

import 'dotenv/config';
import pg from 'pg';
import { google } from 'googleapis';
import fs from 'fs';
import readline from 'readline';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Gmail OAuth2 config
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = 'gmail-token.json';

// Patterns to detect captured opportunities in emails
const CAPTURE_PATTERNS = [
  // PioneerRx patterns
  /(?:rx|prescription)\s*#?\s*(\d+).*?(?:changed|switched|approved|completed)/i,
  /(?:changed|switched|approved)\s*(?:rx|prescription)?\s*#?\s*(\d+)/i,
  /patient\s+([A-Z][a-z]+,?\s*[A-Z][a-z]+).*?(?:approved|completed|changed)/i,
  // Drug change patterns
  /(?:changed|switched)\s+(?:from\s+)?([A-Za-z\s]+)\s+to\s+([A-Za-z\s]+)/i,
];

// Setup OAuth2 client
function getOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';

  if (!clientId || !clientSecret) {
    console.error('❌ Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env');
    console.log('\nTo set up Gmail integration:');
    console.log('1. Go to https://console.cloud.google.com/');
    console.log('2. Create a project and enable Gmail API');
    console.log('3. Create OAuth 2.0 credentials (Desktop app)');
    console.log('4. Add to .env: GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx');
    process.exit(1);
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// First-time setup: get authorization
async function setupAuth() {
  const oAuth2Client = getOAuth2Client();
  
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔐 Gmail Authorization Setup\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in and authorize the app');
  console.log('3. Copy the authorization code and paste it below:\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question('Enter authorization code: ', async (code) => {
      rl.close();
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        
        // Save refresh token to .env
        console.log('\n✅ Authorization successful!\n');
        console.log('Add this to your .env file:\n');
        console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        
        // Also save to token file as backup
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log(`Token also saved to ${TOKEN_PATH}`);
        
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Get authenticated Gmail client
async function getGmailClient() {
  const oAuth2Client = getOAuth2Client();
  
  let refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  
  // Try loading from token file if not in env
  if (!refreshToken && fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    refreshToken = tokens.refresh_token;
  }
  
  if (!refreshToken) {
    console.error('❌ No refresh token found. Run with --setup first.');
    process.exit(1);
  }
  
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// Parse email for captured opportunity info
function parseEmailForCapture(subject, body, snippet) {
  const results = [];
  const text = `${subject} ${body} ${snippet}`.toLowerCase();
  
  // Look for RX numbers
  const rxMatches = text.match(/rx\s*#?\s*(\d{5,7})/gi) || [];
  for (const match of rxMatches) {
    const rxNum = match.replace(/\D/g, '');
    if (rxNum) {
      results.push({ type: 'rx_number', value: rxNum });
    }
  }
  
  // Look for patient names (Last, First format)
  const nameMatches = text.match(/([A-Z][a-z]+),\s*([A-Z][a-z]+)/g) || [];
  for (const match of nameMatches) {
    results.push({ type: 'patient_name', value: match });
  }
  
  // Look for drug changes
  const drugMatches = text.match(/(?:changed|switched|approved).*?([a-z]+(?:\s+[a-z]+)?)\s+to\s+([a-z]+(?:\s+[a-z]+)?)/gi) || [];
  for (const match of drugMatches) {
    results.push({ type: 'drug_change', value: match });
  }
  
  // Determine if this looks like a capture confirmation
  const isCapture = 
    text.includes('approved') ||
    text.includes('changed') ||
    text.includes('switched') ||
    text.includes('completed') ||
    text.includes('rx change') ||
    text.includes('prescription change');
  
  return { isCapture, details: results };
}

// Find matching opportunity in database
async function findMatchingOpportunity(pharmacyId, details) {
  for (const detail of details) {
    if (detail.type === 'rx_number') {
      // Try to match by RX number
      const result = await pool.query(`
        SELECT o.opportunity_id, o.status, o.recommended_drug_name,
               p.first_name, p.last_name
        FROM opportunities o
        JOIN patients p ON p.patient_id = o.patient_id
        JOIN prescriptions pr ON pr.patient_id = o.patient_id
        WHERE o.pharmacy_id = $1 
          AND pr.rx_number = $2
          AND o.status IN ('Not Submitted', 'Submitted')
        LIMIT 1
      `, [pharmacyId, detail.value]);
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
    }
    
    if (detail.type === 'patient_name') {
      // Try to match by patient name
      const [lastName, firstName] = detail.value.split(',').map(s => s.trim());
      const result = await pool.query(`
        SELECT o.opportunity_id, o.status, o.recommended_drug_name,
               p.first_name, p.last_name
        FROM opportunities o
        JOIN patients p ON p.patient_id = o.patient_id
        WHERE o.pharmacy_id = $1 
          AND LOWER(p.last_name) LIKE $2
          AND LOWER(p.first_name) LIKE $3
          AND o.status IN ('Not Submitted', 'Submitted')
        LIMIT 1
      `, [pharmacyId, `${lastName.toLowerCase()}%`, `${firstName.toLowerCase()}%`]);
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
    }
  }
  
  return null;
}

// Update opportunity status to Completed
async function markOpportunityCompleted(opportunityId, emailSubject) {
  await pool.query(`
    UPDATE opportunities 
    SET status = 'Completed',
        staff_notes = COALESCE(staff_notes, '') || E'\n\n[Auto-captured from email: ' || $2 || ']',
        updated_at = NOW()
    WHERE opportunity_id = $1
  `, [opportunityId, emailSubject.slice(0, 100)]);
}

// Main polling function
async function pollGmail(pharmacyEmail, pharmacyId) {
  console.log(`\n📧 Polling Gmail for ${pharmacyEmail}...\n`);
  
  const gmail = await getGmailClient();
  
  // Search for recent emails that might be capture confirmations
  // Look at emails from the last 24 hours
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  
  const query = `after:${oneDayAgo} (subject:rx OR subject:prescription OR subject:approved OR subject:changed OR from:pioneerrx OR from:pharmacy)`;
  
  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50,
    });
    
    const messages = response.data.messages || [];
    console.log(`   Found ${messages.length} potential emails to check`);
    
    let capturedCount = 0;
    
    for (const msg of messages) {
      // Get full message
      const fullMsg = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      
      // Extract subject and body
      const headers = fullMsg.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const snippet = fullMsg.data.snippet || '';
      
      // Get body text
      let body = '';
      const parts = fullMsg.data.payload?.parts || [];
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      if (!body && fullMsg.data.payload?.body?.data) {
        body = Buffer.from(fullMsg.data.payload.body.data, 'base64').toString('utf-8');
      }
      
      // Parse for capture info
      const { isCapture, details } = parseEmailForCapture(subject, body, snippet);
      
      if (isCapture && details.length > 0) {
        console.log(`   📩 Checking: ${subject.slice(0, 60)}...`);
        
        // Try to find matching opportunity
        const match = await findMatchingOpportunity(pharmacyId, details);
        
        if (match && match.status !== 'Completed') {
          console.log(`      ✅ MATCH: ${match.first_name} ${match.last_name} - ${match.recommended_drug_name}`);
          await markOpportunityCompleted(match.opportunity_id, subject);
          capturedCount++;
        }
      }
    }
    
    console.log(`\n✅ Auto-capture complete: ${capturedCount} opportunities marked as Completed`);
    
  } catch (error) {
    console.error('Gmail API error:', error.message);
    if (error.message.includes('invalid_grant')) {
      console.log('\n⚠️  Token expired. Run with --setup to re-authorize.');
    }
  }
}

// Get pharmacy info for a client
async function getPharmacyForClient(clientEmail) {
  const result = await pool.query(`
    SELECT p.pharmacy_id, c.submitter_email
    FROM pharmacies p
    JOIN clients c ON c.client_id = p.client_id
    WHERE c.submitter_email = $1
  `, [clientEmail.toLowerCase()]);
  
  if (result.rows.length === 0) {
    console.error(`❌ Client not found: ${clientEmail}`);
    process.exit(1);
  }
  
  return result.rows[0];
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--setup')) {
  setupAuth().then(() => {
    console.log('\n✅ Setup complete! You can now run: node auto-capture-gmail.js <client-email>');
    process.exit(0);
  }).catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
} else if (args.length < 1) {
  console.log(`
📧 TheRxOS Gmail Auto-Capture

Usage:
  node auto-capture-gmail.js --setup              First-time authorization
  node auto-capture-gmail.js <client-email>       Poll for captures
  node auto-capture-gmail.js <client-email> --watch   Continuous polling (every 5 min)

Example:
  node auto-capture-gmail.js contact@mybravorx.com
  `);
  process.exit(0);
} else {
  const clientEmail = args[0];
  const watchMode = args.includes('--watch');
  
  getPharmacyForClient(clientEmail).then(async ({ pharmacy_id, submitter_email }) => {
    if (watchMode) {
      console.log('👀 Watch mode: polling every 5 minutes (Ctrl+C to stop)\n');
      
      // Initial poll
      await pollGmail(submitter_email, pharmacy_id);
      
      // Then poll every 5 minutes
      setInterval(async () => {
        await pollGmail(submitter_email, pharmacy_id);
      }, 5 * 60 * 1000);
    } else {
      await pollGmail(submitter_email, pharmacy_id);
      await pool.end();
      process.exit(0);
    }
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
