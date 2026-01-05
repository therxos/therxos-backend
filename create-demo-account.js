// create-demo-account.js
// Creates a demo pharmacy with Marvel superhero patient names
// Duplicates Bravo's data structure with randomized names

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Marvel superheroes (prioritizing Marvel over DC as requested!)
const MARVEL_HEROES = [
  // First name, Last name
  ['Peter', 'Parker'],
  ['Tony', 'Stark'],
  ['Steve', 'Rogers'],
  ['Natasha', 'Romanoff'],
  ['Bruce', 'Banner'],
  ['Thor', 'Odinson'],
  ['Clint', 'Barton'],
  ['Wanda', 'Maximoff'],
  ['Vision', 'Jarvis'],
  ['Scott', 'Lang'],
  ['Hope', 'VanDyne'],
  ['Stephen', 'Strange'],
  ['Carol', 'Danvers'],
  ['James', 'Rhodes'],
  ['Sam', 'Wilson'],
  ['Bucky', 'Barnes'],
  ['Peter', 'Quill'],
  ['Gamora', 'Zen-Whoberi'],
  ['Drax', 'Destroyer'],
  ['Rocket', 'Raccoon'],
  ['Groot', 'Flora'],
  ['Nebula', 'Titan'],
  ['Mantis', 'Empath'],
  ['TChalla', 'Udaku'],
  ['Shuri', 'Udaku'],
  ['Okoye', 'Wakanda'],
  ['MBaku', 'Jabari'],
  ['Matt', 'Murdock'],
  ['Jessica', 'Jones'],
  ['Luke', 'Cage'],
  ['Danny', 'Rand'],
  ['Frank', 'Castle'],
  ['Wade', 'Wilson'],
  ['Logan', 'Howlett'],
  ['Charles', 'Xavier'],
  ['Erik', 'Lehnsherr'],
  ['Jean', 'Grey'],
  ['Scott', 'Summers'],
  ['Ororo', 'Munroe'],
  ['Hank', 'McCoy'],
  ['Bobby', 'Drake'],
  ['Rogue', 'Marie'],
  ['Remy', 'LeBeau'],
  ['Kurt', 'Wagner'],
  ['Kitty', 'Pryde'],
  ['Piotr', 'Rasputin'],
  ['Anna', 'Marie'],
  ['Warren', 'Worthington'],
  ['Betsy', 'Braddock'],
  ['Emma', 'Frost'],
  ['Miles', 'Morales'],
  ['Gwen', 'Stacy'],
  ['Miguel', 'OHara'],
  ['Jessica', 'Drew'],
  ['Felicia', 'Hardy'],
  ['Mary', 'Jane'],
  ['Eddie', 'Brock'],
  ['Cletus', 'Kasady'],
  ['Norman', 'Osborn'],
  ['Harry', 'Osborn'],
  ['Otto', 'Octavius'],
  ['Adrian', 'Toomes'],
  ['Quentin', 'Beck'],
  ['Max', 'Dillon'],
  ['Flint', 'Marko'],
  ['Sergei', 'Kravinoff'],
  ['Wilson', 'Fisk'],
  ['Loki', 'Laufeyson'],
  ['Hela', 'Odinsdottir'],
  ['Thanos', 'Titan'],
  ['Ronan', 'Accuser'],
  ['Ultron', 'Prime'],
  ['Kang', 'Conqueror'],
  ['Victor', 'VonDoom'],
  ['Reed', 'Richards'],
  ['Sue', 'Storm'],
  ['Johnny', 'Storm'],
  ['Ben', 'Grimm'],
  ['Namor', 'McKenzie'],
  ['Marc', 'Spector'],
  ['Steven', 'Grant'],
  ['Jake', 'Lockley'],
  ['Jennifer', 'Walters'],
  ['Kamala', 'Khan'],
  ['Kate', 'Bishop'],
  ['Yelena', 'Belova'],
  ['Maya', 'Lopez'],
  ['America', 'Chavez'],
  ['Xialing', 'Xu'],
  ['Shang', 'Chi'],
  ['Kingo', 'Sunen'],
  ['Sersi', 'Eternal'],
  ['Ikaris', 'Eternal'],
  ['Thena', 'Eternal'],
  ['Ajak', 'Prime'],
  ['Gilgamesh', 'Forgotten'],
  ['Phastos', 'Eternal'],
  ['Makkari', 'Eternal'],
  ['Druig', 'Eternal'],
  ['Sprite', 'Eternal'],
  // Adding more to reach ~700 unique names
  ['Nick', 'Fury'],
  ['Maria', 'Hill'],
  ['Phil', 'Coulson'],
  ['Melinda', 'May'],
  ['Daisy', 'Johnson'],
  ['Jemma', 'Simmons'],
  ['Leo', 'Fitz'],
  ['Grant', 'Ward'],
  ['Lance', 'Hunter'],
  ['Bobbi', 'Morse'],
  ['Elena', 'Rodriguez'],
  ['Mack', 'Mackenzie'],
  ['Lincoln', 'Campbell'],
  ['Joey', 'Gutierrez'],
  ['Robbie', 'Reyes'],
  ['Eli', 'Morrow'],
  ['Gabe', 'Reyes'],
  ['Holden', 'Radcliffe'],
  ['Aida', 'Framework'],
  ['Jeffrey', 'Mace'],
  ['Glenn', 'Talbot'],
  ['Hive', 'Ward'],
  ['Gideon', 'Malick'],
  ['Werner', 'Strucker'],
  ['Raina', 'Flowers'],
  ['Cal', 'Johnson'],
  ['Jiaying', 'Afterlife'],
  ['Gordon', 'Eyeless'],
  ['Daniel', 'Whitehall'],
  ['Sunil', 'Bakshi'],
  ['John', 'Garrett'],
  ['Ian', 'Quinn'],
  ['Edison', 'Po'],
  ['Carl', 'Creel'],
  ['Marcus', 'Scarlotti'],
  ['Blizzard', 'Gill'],
  ['Absorbing', 'Man'],
  ['Deathlok', 'Peterson'],
  ['Mike', 'Peterson'],
  ['Reva', 'Connors'],
  ['Trish', 'Walker'],
  ['Malcolm', 'Ducasse'],
  ['Jeri', 'Hogarth'],
  ['Dorothy', 'Walker'],
  ['Will', 'Simpson'],
  ['Kilgrave', 'Kevin'],
  ['Misty', 'Knight'],
  ['Claire', 'Temple'],
  ['Colleen', 'Wing'],
  ['Joy', 'Meachum'],
  ['Ward', 'Meachum'],
  ['Harold', 'Meachum'],
  ['Davos', 'Steel'],
  ['Bakuto', 'Hand'],
  ['Madame', 'Gao'],
  ['Alexandra', 'Reid'],
  ['Murakami', 'Hand'],
  ['Sowande', 'Hand'],
  ['Elektra', 'Natchios'],
  ['Stick', 'Chaste'],
  ['Bullseye', 'Poindexter'],
  ['Ray', 'Nadeem'],
  ['Foggy', 'Nelson'],
  ['Karen', 'Page'],
  ['Brett', 'Mahoney'],
  ['Ben', 'Urich'],
  ['Vanessa', 'Marianna'],
  ['James', 'Wesley'],
  ['Leland', 'Owlsley'],
  ['Nobu', 'Yoshioka'],
  ['Turk', 'Barrett'],
  ['Curtis', 'Hoyle'],
  ['Billy', 'Russo'],
  ['Dinah', 'Madani'],
  ['David', 'Lieberman'],
  ['Amy', 'Bendix'],
  ['John', 'Pilgrim'],
  ['Eliza', 'Schultz'],
  ['Anderson', 'Schultz'],
  // More X-Men villains and supporting cast
  ['Mystique', 'Darkholme'],
  ['Victor', 'Creed'],
  ['Jason', 'Stryker'],
  ['William', 'Stryker'],
  ['Bolivar', 'Trask'],
  ['Sebastian', 'Shaw'],
  ['Azazel', 'Demon'],
  ['Riptide', 'Janos'],
  ['Angel', 'Salvadore'],
  ['Darwin', 'Muñoz'],
  ['Banshee', 'Cassidy'],
  ['Havok', 'Summers'],
  ['Moira', 'MacTaggert'],
  ['Yukio', 'Ronin'],
  ['Mariko', 'Yashida'],
  ['Shingen', 'Yashida'],
  ['Viper', 'Ophelia'],
  ['Silver', 'Samurai'],
  ['Laura', 'Kinney'],
  ['Caliban', 'Morlock'],
  ['Donald', 'Pierce'],
  ['Zander', 'Rice'],
  ['Cable', 'Summers'],
  ['Domino', 'Neena'],
  ['Vanisher', 'Telford'],
  ['Bedlam', 'Jesse'],
  ['Shatterstar', 'Gaveedra'],
  ['Zeitgeist', 'Axel'],
  ['Colossus', 'Rasputin'],
  ['Warhead', 'Negasonic'],
  ['Yukio', 'Girlfriend'],
  ['Russell', 'Collins'],
  ['Black', 'Tom'],
  ['Ajax', 'Francis'],
  ['Angel', 'Dust'],
  ['Weasel', 'Jack'],
  ['Blind', 'Al'],
  ['Dopinder', 'Driver'],
  ['Negasonic', 'Warhead'],
];

// Generate random DOB between 1940-2000
function randomDOB() {
  const year = 1940 + Math.floor(Math.random() * 60);
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Shuffle array
function shuffle(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function createDemoAccount() {
  console.log('\n🦸 Creating Demo Superhero Pharmacy Account...\n');

  // 1. Create or get client
  const clientName = 'Hero Pharmacy (Demo)';
  const clientEmail = 'demo@therxos.com';
  const dashboardSubdomain = 'hero-demo';

  // Check if client already exists
  let clientId;
  const existingClient = await pool.query(`
    SELECT client_id FROM clients WHERE submitter_email = $1
  `, [clientEmail]);
  
  if (existingClient.rows.length > 0) {
    clientId = existingClient.rows[0].client_id;
    console.log(`✅ Using existing client: ${clientName}`);
  } else {
    clientId = uuidv4();
    await pool.query(`
      INSERT INTO clients (client_id, client_name, dashboard_subdomain, submitter_email, status, created_at)
      VALUES ($1, $2, $3, $4, 'active', NOW())
    `, [clientId, clientName, dashboardSubdomain, clientEmail]);
    console.log(`✅ Client: ${clientName}`);
  }

  // 2. Create pharmacy - first check if one exists for this client
  let pharmacyId;
  const existingPharmacy = await pool.query(`
    SELECT pharmacy_id FROM pharmacies WHERE client_id = $1 LIMIT 1
  `, [clientId]);
  
  if (existingPharmacy.rows.length > 0) {
    pharmacyId = existingPharmacy.rows[0].pharmacy_id;
    console.log(`✅ Using existing pharmacy: ${pharmacyId}`);
  } else {
    pharmacyId = uuidv4();
    await pool.query(`
      INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, state, pms_system, timezone, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [pharmacyId, clientId, 'Hero Pharmacy', '9999999999', 'NY', 'demo', 'America/New_York', true]);
    console.log(`✅ Pharmacy: Hero Pharmacy`);
  }

  // 3. Create demo user
  const userId = uuidv4();
  const passwordHash = createHash('sha256').update('demo1234').digest('hex');
  
  await pool.query(`
    INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (email) DO UPDATE SET 
      pharmacy_id = EXCLUDED.pharmacy_id,
      client_id = EXCLUDED.client_id,
      first_name = EXCLUDED.first_name,
      password_hash = EXCLUDED.password_hash
    RETURNING user_id
  `, [userId, clientId, pharmacyId, 'demo@therxos.com', passwordHash, 'Tony', 'Stark', 'admin']);
  
  console.log(`✅ User: demo@therxos.com (password: demo1234)`);

  // 4. Get Bravo's data to duplicate
  const bravoPharmacy = await pool.query(`
    SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1
  `);
  
  if (bravoPharmacy.rows.length === 0) {
    console.error('❌ Bravo Pharmacy not found - cannot duplicate data');
    process.exit(1);
  }
  
  const bravoId = bravoPharmacy.rows[0].pharmacy_id;
  console.log(`\n📋 Duplicating data from Bravo (${bravoId})...\n`);

  // 5. Get Bravo patients
  const bravoPatients = await pool.query(`
    SELECT * FROM patients WHERE pharmacy_id = $1
  `, [bravoId]);
  
  console.log(`   Found ${bravoPatients.rows.length} patients to duplicate`);

  // Shuffle hero names and create mapping
  const shuffledHeroes = shuffle(MARVEL_HEROES);
  const patientMapping = new Map(); // old patient_id -> new patient_id
  
  let heroIndex = 0;
  const heroPatients = [];
  
  for (const patient of bravoPatients.rows) {
    // Get hero name (cycle if we run out)
    const [firstName, lastName] = shuffledHeroes[heroIndex % shuffledHeroes.length];
    heroIndex++;
    
    const newPatientId = uuidv4();
    const newHash = createHash('sha256').update(`${firstName}|${lastName}|${patient.date_of_birth}`.toLowerCase()).digest('hex');
    
    patientMapping.set(patient.patient_id, newPatientId);
    
    heroPatients.push({
      patient_id: newPatientId,
      pharmacy_id: pharmacyId,
      patient_hash: newHash,
      first_name: firstName,
      last_name: lastName,
      date_of_birth: patient.date_of_birth,
      chronic_conditions: patient.chronic_conditions,
      primary_insurance_bin: patient.primary_insurance_bin,
      primary_insurance_group: patient.primary_insurance_group,
      profile_data: patient.profile_data,
    });
  }

  // Insert patients
  for (const p of heroPatients) {
    await pool.query(`
      INSERT INTO patients (patient_id, pharmacy_id, patient_hash, first_name, last_name, date_of_birth, 
        chronic_conditions, primary_insurance_bin, primary_insurance_group, profile_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT DO NOTHING
    `, [p.patient_id, p.pharmacy_id, p.patient_hash, p.first_name, p.last_name, p.date_of_birth,
        p.chronic_conditions, p.primary_insurance_bin, p.primary_insurance_group, p.profile_data]);
  }
  console.log(`   ✅ Created ${heroPatients.length} superhero patients`);

  // 6. Duplicate prescriptions
  const bravoPrescriptions = await pool.query(`
    SELECT * FROM prescriptions WHERE pharmacy_id = $1
  `, [bravoId]);
  
  console.log(`   Found ${bravoPrescriptions.rows.length} prescriptions to duplicate`);
  
  let rxCount = 0;
  for (const rx of bravoPrescriptions.rows) {
    const newPatientId = patientMapping.get(rx.patient_id);
    if (!newPatientId) continue;
    
    try {
      await pool.query(`
        INSERT INTO prescriptions (prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
          quantity_dispensed, days_supply, dispensed_date, insurance_bin, insurance_group,
          contract_id, plan_name, patient_pay, insurance_pay, prescriber_name, daw_code, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT DO NOTHING
      `, [
        uuidv4(), pharmacyId, newPatientId, rx.rx_number, rx.ndc, rx.drug_name,
        rx.quantity_dispensed, rx.days_supply, rx.dispensed_date, rx.insurance_bin, rx.insurance_group,
        rx.contract_id, rx.plan_name, rx.patient_pay, rx.insurance_pay, rx.prescriber_name, rx.daw_code, rx.raw_data
      ]);
      rxCount++;
    } catch (e) {
      // Skip duplicates
    }
  }
  console.log(`   ✅ Created ${rxCount} prescriptions`);

  // 7. Duplicate opportunities
  const bravoOpps = await pool.query(`
    SELECT * FROM opportunities WHERE pharmacy_id = $1
  `, [bravoId]);
  
  console.log(`   Found ${bravoOpps.rows.length} opportunities to duplicate`);
  
  let oppCount = 0;
  for (const opp of bravoOpps.rows) {
    const newPatientId = patientMapping.get(opp.patient_id);
    if (!newPatientId) continue;
    
    try {
      await pool.query(`
        INSERT INTO opportunities (opportunity_id, pharmacy_id, patient_id, opportunity_type,
          current_ndc, current_drug_name, recommended_drug_name,
          potential_margin_gain, annual_margin_gain, clinical_rationale, clinical_priority, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT DO NOTHING
      `, [
        uuidv4(), pharmacyId, newPatientId, opp.opportunity_type,
        opp.current_ndc, opp.current_drug_name, opp.recommended_drug_name,
        opp.potential_margin_gain, opp.annual_margin_gain, opp.clinical_rationale, opp.clinical_priority, 
        'Not Submitted' // Reset all to Not Submitted for demo
      ]);
      oppCount++;
    } catch (e) {
      // Skip errors
    }
  }
  console.log(`   ✅ Created ${oppCount} opportunities`);

  // Summary
  console.log(`\n🎉 Demo Account Created Successfully!`);
  console.log(`\n   📧 Login: demo@therxos.com`);
  console.log(`   🔑 Password: demo1234`);
  console.log(`   🏥 Pharmacy: Hero Pharmacy`);
  console.log(`   👥 Patients: ${heroPatients.length} (Marvel heroes)`);
  console.log(`   💊 Prescriptions: ${rxCount}`);
  console.log(`   💰 Opportunities: ${oppCount}`);
  
  await pool.end();
}

createDemoAccount().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
