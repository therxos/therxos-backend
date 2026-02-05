// Duplicate Opportunity Cleanup Script
// Run with: node cleanup-duplicates.js [pharmacy-email] [--dry-run]
// --dry-run will only report duplicates without deleting

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function findDuplicates(pharmacyId = null) {
  // Find opportunities that have the same patient + opportunity_type + current_drug
  // These are likely duplicates

  let query = `
    SELECT
      o.patient_id,
      o.opportunity_type,
      o.current_drug_name,
      o.recommended_drug_name,
      COUNT(*) as duplicate_count,
      array_agg(o.opportunity_id ORDER BY o.created_at DESC) as opportunity_ids,
      array_agg(o.status ORDER BY o.created_at DESC) as statuses,
      array_agg(o.created_at ORDER BY o.created_at DESC) as created_dates,
      p.pharmacy_name
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
  `;

  const params = [];
  if (pharmacyId) {
    query += ` WHERE o.pharmacy_id = $1`;
    params.push(pharmacyId);
  }

  query += `
    GROUP BY o.patient_id, o.opportunity_type, o.current_drug_name, o.recommended_drug_name, p.pharmacy_name
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, p.pharmacy_name
  `;

  const result = await pool.query(query, params);
  return result.rows;
}

async function getPharmacyStats() {
  const result = await pool.query(`
    SELECT
      p.pharmacy_id,
      p.pharmacy_name,
      COUNT(o.opportunity_id) as total_opportunities,
      COUNT(DISTINCT o.patient_id) as unique_patients,
      COUNT(*) FILTER (WHERE o.status = 'Not Submitted') as not_submitted,
      COUNT(*) FILTER (WHERE o.status = 'Flagged') as flagged,
      COUNT(*) FILTER (WHERE o.status = 'Denied') as denied,
      COUNT(*) FILTER (WHERE o.status = 'Completed' OR o.status = 'Approved') as completed
    FROM pharmacies p
    LEFT JOIN opportunities o ON o.pharmacy_id = p.pharmacy_id
    GROUP BY p.pharmacy_id, p.pharmacy_name
    ORDER BY total_opportunities DESC
  `);
  return result.rows;
}

async function cleanupDuplicates(pharmacyId = null, dryRun = true) {
  const duplicates = await findDuplicates(pharmacyId);

  console.log(`\nFound ${duplicates.length} groups of duplicate opportunities\n`);

  let totalToDelete = 0;
  const toDelete = [];

  for (const dup of duplicates) {
    const ids = dup.opportunity_ids;
    const statuses = dup.statuses;

    // Keep the one with the "best" status, or the newest if all same status
    // Priority: Completed > Approved > Submitted > Not Submitted > Flagged > Denied
    const statusPriority = {
      'Completed': 6,
      'Approved': 5,
      'Submitted': 4,
      'Not Submitted': 3,
      'Flagged': 2,
      'Denied': 1,
      "Didn't Work": 0
    };

    let keepIndex = 0;
    let keepPriority = statusPriority[statuses[0]] || 0;

    for (let i = 1; i < ids.length; i++) {
      const priority = statusPriority[statuses[i]] || 0;
      if (priority > keepPriority) {
        keepPriority = priority;
        keepIndex = i;
      }
    }

    // Delete all except the one to keep
    const keepId = ids[keepIndex];
    const deleteIds = ids.filter((_, i) => i !== keepIndex);

    console.log(`Duplicate group: ${dup.pharmacy_name}`);
    console.log(`  Type: ${dup.opportunity_type}`);
    console.log(`  Drug: ${dup.current_drug_name} -> ${dup.recommended_drug_name}`);
    console.log(`  Count: ${dup.duplicate_count}`);
    console.log(`  Keeping: ${keepId} (status: ${statuses[keepIndex]})`);
    console.log(`  Deleting: ${deleteIds.length} duplicates`);
    console.log('');

    toDelete.push(...deleteIds);
    totalToDelete += deleteIds.length;
  }

  console.log(`\nTotal duplicates to delete: ${totalToDelete}`);

  if (!dryRun && toDelete.length > 0) {
    console.log('\nDeleting duplicates...');

    // Delete in batches
    const batchSize = 100;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      await pool.query(`DELETE FROM opportunities WHERE opportunity_id = ANY($1)`, [batch]);
      console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toDelete.length / batchSize)}`);
    }

    console.log(`\nDeleted ${toDelete.length} duplicate opportunities`);
  } else if (dryRun) {
    console.log('\n[DRY RUN] No changes made. Remove --dry-run to actually delete.');
  }

  return { duplicateGroups: duplicates.length, deletedCount: dryRun ? 0 : toDelete.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pharmacyEmail = args.find(a => !a.startsWith('--'));

  console.log('='.repeat(60));
  console.log('TheRxOS Duplicate Opportunity Cleanup');
  console.log('='.repeat(60));

  // Show current stats
  console.log('\n📊 Current Pharmacy Stats:\n');
  const stats = await getPharmacyStats();
  for (const s of stats) {
    console.log(`${s.pharmacy_name}:`);
    console.log(`  Total: ${s.total_opportunities} | Patients: ${s.unique_patients}`);
    console.log(`  Not Submitted: ${s.not_submitted} | Completed: ${s.completed} | Flagged: ${s.flagged} | Denied: ${s.denied}`);
    console.log('');
  }

  // Find pharmacy if email provided
  let pharmacyId = null;
  if (pharmacyEmail) {
    const result = await pool.query(`
      SELECT p.pharmacy_id, p.pharmacy_name
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE c.submitter_email ILIKE $1 OR p.pharmacy_name ILIKE $1
      LIMIT 1
    `, [`%${pharmacyEmail}%`]);

    if (result.rows.length > 0) {
      pharmacyId = result.rows[0].pharmacy_id;
      console.log(`\n🎯 Targeting pharmacy: ${result.rows[0].pharmacy_name}\n`);
    } else {
      console.log(`\n⚠️  No pharmacy found matching "${pharmacyEmail}", checking all pharmacies\n`);
    }
  }

  // Run cleanup
  await cleanupDuplicates(pharmacyId, dryRun);

  // Show updated stats if not dry run
  if (!dryRun) {
    console.log('\n📊 Updated Pharmacy Stats:\n');
    const newStats = await getPharmacyStats();
    for (const s of newStats) {
      console.log(`${s.pharmacy_name}: ${s.total_opportunities} opportunities`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
