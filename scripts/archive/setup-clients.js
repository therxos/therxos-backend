// TheRxOS V2 - Client Setup & Data Ingestion Script
// Run with: node setup-clients.js
// Then run: node ingest-data.js <client-email> <csv-file-path>

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ============================================
// CLIENT CONFIGURATION
// ============================================
const CLIENTS = [
  {
    pharmacyName: 'Bravo Pharmacy',
    npi: '1699154427',
    email: 'contact@mybravorx.com',
    state: 'MA',
    subdomain: 'bravo',
    ownerFirstName: 'Bravo',
    ownerLastName: 'Admin',
  },
  {
    pharmacyName: 'Aracoma Drug',
    npi: '1780639286',
    email: 'michaelbakerrph@gmail.com',
    state: 'WV',
    subdomain: 'aracoma',
    ownerFirstName: 'Michael',
    ownerLastName: 'Baker',
  },
];

const DEFAULT_PASSWORD = 'therxos1234';

// ============================================
// SETUP CLIENTS
// ============================================
async function setupClients() {
  console.log('🚀 Setting up clients...\n');
  
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  
  for (const client of CLIENTS) {
    console.log(`\n📦 Setting up ${client.pharmacyName}...`);
    
    try {
      // Check if client already exists
      const existing = await pool.query(
        'SELECT client_id FROM clients WHERE submitter_email = $1',
        [client.email.toLowerCase()]
      );
      
      if (existing.rows.length > 0) {
        console.log(`   ⚠️  Client already exists, skipping...`);
        continue;
      }
      
      const clientId = uuidv4();
      const pharmacyId = uuidv4();
      const userId = uuidv4();
      
      // Create client
      await pool.query(`
        INSERT INTO clients (
          client_id, client_name, pharmacy_npi, submitter_email, 
          dashboard_subdomain, primary_contact_name, status, subscription_tier
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        clientId, 
        client.pharmacyName, 
        client.npi, 
        client.email.toLowerCase(),
        client.subdomain,
        `${client.ownerFirstName} ${client.ownerLastName}`,
        'active',
        'professional'
      ]);
      console.log(`   ✅ Client record created`);
      
      // Create pharmacy
      await pool.query(`
        INSERT INTO pharmacies (
          pharmacy_id, client_id, pharmacy_npi, pharmacy_name, 
          state, pms_system, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        pharmacyId,
        clientId,
        client.npi,
        client.pharmacyName,
        client.state,
        'pioneerrx',
        true
      ]);
      console.log(`   ✅ Pharmacy record created`);
      
      // Create user
      await pool.query(`
        INSERT INTO users (
          user_id, client_id, pharmacy_id, email, password_hash,
          first_name, last_name, role, is_active, must_change_password
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        userId,
        clientId,
        pharmacyId,
        client.email.toLowerCase(),
        passwordHash,
        client.ownerFirstName,
        client.ownerLastName,
        'owner',
        true,
        false  // Set to true if you want them to change password on first login
      ]);
      console.log(`   ✅ User account created`);
      
      console.log(`\n   📋 Login credentials for ${client.pharmacyName}:`);
      console.log(`      Email: ${client.email}`);
      console.log(`      Password: ${DEFAULT_PASSWORD}`);
      console.log(`      Dashboard: https://beta.therxos.com/login`);
      
    } catch (error) {
      console.error(`   ❌ Error setting up ${client.pharmacyName}:`, error.message);
      console.error(`      Full error:`, error);
    }
  }
  
  console.log('\n✨ Client setup complete!\n');
}

// Run setup
setupClients()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
