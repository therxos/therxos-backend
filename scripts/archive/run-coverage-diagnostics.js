#!/usr/bin/env node
/**
 * Coverage Intelligence Diagnostics
 *
 * Run this script to diagnose coverage verification issues and test the system.
 *
 * Usage:
 *   node run-coverage-diagnostics.js                    # Run full diagnostics
 *   node run-coverage-diagnostics.js --pharmacy <id>    # For specific pharmacy
 *   node run-coverage-diagnostics.js --opportunity <id> # Diagnose specific opportunity
 *   node run-coverage-diagnostics.js --test-cms         # Test CMS API connectivity
 *   node run-coverage-diagnostics.js --scan             # Run verification scan
 *   node run-coverage-diagnostics.js --report           # Generate detailed report
 */

import 'dotenv/config';
import db from './src/database/index.js';
import coverageIntelligence from './src/services/coverage-intelligence.js';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    flags[args[i].substring(2)] = args[i + 1] || true;
    if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          THERXOS COVERAGE INTELLIGENCE DIAGNOSTICS         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Test database connection
    console.log('📊 Testing database connection...');
    const dbHealth = await db.healthCheck();
    console.log(`   Database: ${dbHealth ? '✅ Connected' : '❌ Failed'}\n`);

    if (!dbHealth) {
      console.error('Cannot proceed without database connection.');
      process.exit(1);
    }

    if (flags['test-cms']) {
      await testCMSAPI();
    } else if (flags.opportunity) {
      await diagnoseOpportunity(flags.opportunity);
    } else if (flags.scan) {
      await runScan(flags.pharmacy);
    } else if (flags.report) {
      await generateReport(flags.pharmacy);
    } else {
      await runFullDiagnostics(flags.pharmacy);
    }

  } catch (error) {
    console.error('\n❌ Diagnostics failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await db.end();
  }
}

async function runFullDiagnostics(pharmacyId) {
  console.log('🔍 Running full diagnostics...\n');

  // 1. Check table existence
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1️⃣  REQUIRED TABLES CHECK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const requiredTables = [
    'formulary_items',
    'insurance_contracts',
    'coverage_verification_log',
    'opportunity_workability',
    'cms_plan_reference',
    'medicare_formulary',
    'drug_pricing'
  ];

  for (const table of requiredTables) {
    const exists = await checkTableExists(table);
    console.log(`   ${table}: ${exists ? '✅ Exists' : '❌ MISSING'}`);
  }

  // 2. Check data counts
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('2️⃣  DATA VOLUME CHECK');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const dataCounts = await getDataCounts(pharmacyId);
  console.log(`   Opportunities (Not Submitted): ${dataCounts.opportunities}`);
  console.log(`   With recommended NDC:          ${dataCounts.withNdc}`);
  console.log(`   Coverage verified:             ${dataCounts.verified}`);
  console.log(`   With workability score:        ${dataCounts.scored}`);
  console.log(`   Formulary items:               ${dataCounts.formularyItems}`);
  console.log(`   Insurance contracts:           ${dataCounts.insuranceContracts}`);
  console.log(`   Medicare formulary entries:    ${dataCounts.medicareFormulary}`);
  console.log(`   Drug pricing entries:          ${dataCounts.drugPricing}`);

  // 3. Coverage verification stats
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3️⃣  COVERAGE VERIFICATION STATS (Last 7 Days)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const verificationStats = await getVerificationStats(pharmacyId);
  console.log(`   Total verifications:    ${verificationStats.total}`);
  console.log(`   Successful:             ${verificationStats.successful} (${verificationStats.successRate}%)`);
  console.log(`   Failed:                 ${verificationStats.failed}`);
  console.log(`   Covered:                ${verificationStats.covered} (${verificationStats.coveredRate}%)`);
  console.log(`   Not covered:            ${verificationStats.notCovered}`);
  console.log(`   Avg response time:      ${verificationStats.avgResponseTime}ms`);

  // 4. Insurance data quality
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('4️⃣  INSURANCE DATA QUALITY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const insuranceQuality = await getInsuranceDataQuality(pharmacyId);
  console.log(`   Prescriptions with contract_id: ${insuranceQuality.withContractId} (${insuranceQuality.contractIdPct}%)`);
  console.log(`   Prescriptions with BIN:         ${insuranceQuality.withBin} (${insuranceQuality.binPct}%)`);
  console.log(`   Medicare Part D plans:          ${insuranceQuality.medicarePartD}`);
  console.log(`   Unique BINs:                    ${insuranceQuality.uniqueBins}`);
  console.log(`   Unique contract IDs:            ${insuranceQuality.uniqueContractIds}`);

  // 5. Top issues
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('5️⃣  TOP ISSUES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const issues = await getTopIssues(pharmacyId);
  if (issues.length === 0) {
    console.log('   No issues recorded in the last 24 hours.');
  } else {
    issues.forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue.error_message || 'Unknown error'} (${issue.count}x)`);
    });
  }

  // 6. Workability distribution
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('6️⃣  WORKABILITY DISTRIBUTION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const workability = await getWorkabilityDistribution(pharmacyId);
  const grades = ['A', 'B', 'C', 'D', 'F'];
  const bars = { A: '🟢', B: '🟡', C: '🟠', D: '🔴', F: '⚫' };

  for (const grade of grades) {
    const data = workability.find(w => w.grade === grade) || { count: 0, pct: 0 };
    const bar = bars[grade].repeat(Math.ceil(data.pct / 5)) || '░';
    console.log(`   Grade ${grade}: ${String(data.count).padStart(5)} (${String(data.pct).padStart(5)}%) ${bar}`);
  }

  // 7. Sample opportunities missing coverage
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('7️⃣  SAMPLE OPPORTUNITIES MISSING COVERAGE (Top 5 by Margin)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const missingCoverage = await getSampleMissingCoverage(pharmacyId);
  if (missingCoverage.length === 0) {
    console.log('   All opportunities have coverage verification! 🎉');
  } else {
    for (const opp of missingCoverage) {
      console.log(`   • ${opp.recommended_drug || 'Unknown drug'}`);
      console.log(`     NDC: ${opp.recommended_ndc || 'MISSING'} | Margin: $${opp.annual_margin_gain || 0}`);
      console.log(`     Patient: ${opp.patient_name || 'Unknown'} | ID: ${opp.opportunity_id}`);
      console.log('');
    }
  }

  // 8. Recommendations
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('8️⃣  RECOMMENDATIONS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const recommendations = generateRecommendations(dataCounts, verificationStats, insuranceQuality);
  recommendations.forEach((rec, i) => {
    const icon = rec.severity === 'critical' ? '🔴' : rec.severity === 'warning' ? '🟡' : '🟢';
    console.log(`   ${icon} ${rec.message}`);
    if (rec.action) console.log(`      → ${rec.action}`);
  });

  console.log('\n✅ Diagnostics complete.\n');
}

async function testCMSAPI() {
  console.log('🔌 Testing CMS API connectivity...\n');

  const testCases = [
    { contractId: 'H0543', planId: '001', ndc: '00002143380', drug: 'Ozempic' },
    { contractId: 'H3312', planId: '001', ndc: '00169413712', drug: 'Jardiance' },
    { contractId: 'S5768', planId: '001', ndc: '00002777501', drug: 'Trulicity' }
  ];

  for (const test of testCases) {
    console.log(`   Testing ${test.drug} (${test.ndc}) on ${test.contractId}-${test.planId}...`);

    const startTime = Date.now();
    try {
      const url = `https://data.cms.gov/data-api/v1/dataset/92e6c325-eb8e-40a1-9e56-cb66afee89f6/data?` +
        `filter[CONTRACT_ID]=${test.contractId}&filter[PLAN_ID]=${test.planId}&filter[NDC]=${test.ndc}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      const elapsed = Date.now() - startTime;

      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          console.log(`   ✅ SUCCESS (${elapsed}ms) - Tier ${data[0].TIER_LEVEL_VALUE}, PA: ${data[0].PRIOR_AUTHORIZATION_YN}`);
        } else {
          console.log(`   ⚠️  No data returned (${elapsed}ms) - Drug may not be on this plan's formulary`);
        }
      } else {
        console.log(`   ❌ FAILED (${elapsed}ms) - HTTP ${response.status}`);
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.log(`   ❌ ERROR (${elapsed}ms) - ${error.message}`);
    }
  }

  console.log('\n✅ CMS API test complete.\n');
}

async function diagnoseOpportunity(opportunityId) {
  console.log(`🔍 Diagnosing opportunity: ${opportunityId}\n`);

  try {
    const diagnosis = await coverageIntelligence.diagnoseCoverageIssues(opportunityId);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('OPPORTUNITY DETAILS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`   Drug: ${diagnosis.drug}`);
    console.log(`   NDC:  ${diagnosis.ndc}`);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('DIAGNOSTIC CHECKS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const check of diagnosis.checks) {
      const icon = check.passed === true ? '✅' : check.passed === false ? '❌' : '⚪';
      console.log(`   ${icon} ${check.name}`);
      if (check.value && typeof check.value === 'object') {
        console.log(`      ${JSON.stringify(check.value, null, 2).split('\n').join('\n      ')}`);
      } else if (check.value) {
        console.log(`      Value: ${check.value}`);
      }
    }

    if (diagnosis.issues.length > 0) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('ISSUES FOUND');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      diagnosis.issues.forEach((issue, i) => {
        console.log(`   ${i + 1}. ${issue}`);
      });
    }

    if (diagnosis.recommendations.length > 0) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('RECOMMENDATIONS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      diagnosis.recommendations.forEach((rec, i) => {
        console.log(`   ${i + 1}. ${rec}`);
      });
    }

    console.log(`\n   Overall Health: ${diagnosis.overallHealth.toUpperCase()}`);
    console.log(`   Passed: ${diagnosis.passedChecks} | Failed: ${diagnosis.failedChecks}\n`);

  } catch (error) {
    console.error('   ❌ Diagnosis failed:', error.message);
  }
}

async function runScan(pharmacyId) {
  console.log('🚀 Running coverage intelligence scan...\n');

  const result = await coverageIntelligence.runCoverageIntelligenceScan({
    pharmacyId: pharmacyId || null,
    verifyLimit: 100,
    scoreLimit: 200
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCAN RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`   Pharmacies processed: ${result.pharmacies.length}`);
  console.log(`   Opportunities verified: ${result.totals.verified}`);
  console.log(`   Opportunities scored: ${result.totals.scored}`);
  console.log(`   Errors: ${result.totals.errors}`);
  console.log(`   Duration: ${result.duration}ms`);

  if (result.pharmacies.length > 0) {
    console.log('\n   By Pharmacy:');
    for (const p of result.pharmacies) {
      if (p.error) {
        console.log(`   ❌ ${p.pharmacyName}: ${p.error}`);
      } else {
        console.log(`   ✅ ${p.pharmacyName}: ${p.verified} verified, ${p.scored} scored`);
      }
    }
  }

  console.log('\n✅ Scan complete.\n');
}

async function generateReport(pharmacyId) {
  console.log('📊 Generating detailed coverage report...\n');

  const dashboard = await coverageIntelligence.getCoverageDashboard(pharmacyId);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('COVERAGE INTELLIGENCE DASHBOARD');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('SUCCESS RATES (Last 7 Days):');
  console.log(`   Total checks:      ${dashboard.successRates.total_checks || 0}`);
  console.log(`   Successful:        ${dashboard.successRates.successful_checks || 0}`);
  console.log(`   Success rate:      ${dashboard.successRates.success_rate || 0}%`);
  console.log(`   Covered rate:      ${dashboard.successRates.covered_rate || 0}%`);
  console.log(`   Avg response:      ${dashboard.successRates.avg_response_ms || 0}ms`);

  console.log('\nWORKABILITY DISTRIBUTION:');
  for (const w of dashboard.workabilityDistribution) {
    console.log(`   Grade ${w.grade}: ${w.count} opportunities (${w.pct_of_total}%)`);
  }

  console.log('\nSOURCE BREAKDOWN:');
  for (const s of dashboard.sourceBreakdown) {
    console.log(`   ${s.verification_source}: ${s.count} checks, ${s.covered} covered, ${s.avg_ms}ms avg`);
  }

  if (dashboard.alerts.length > 0) {
    console.log('\nALERTS:');
    for (const alert of dashboard.alerts) {
      const icon = alert.severity === 'critical' ? '🔴' : '🟡';
      console.log(`   ${icon} ${alert.message}`);
      console.log(`      → ${alert.recommendation}`);
    }
  }

  console.log('\n✅ Report complete.\n');
}

// Helper functions

async function checkTableExists(tableName) {
  const result = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = $1
    )
  `, [tableName]);
  return result.rows[0].exists;
}

async function getDataCounts(pharmacyId) {
  const filter = pharmacyId ? 'AND o.pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM opportunities o WHERE status = 'Not Submitted' ${filter}) as opportunities,
      (SELECT COUNT(*) FROM opportunities o WHERE status = 'Not Submitted' AND recommended_ndc IS NOT NULL ${filter}) as with_ndc,
      (SELECT COUNT(*) FROM opportunities o WHERE status = 'Not Submitted' AND coverage_verified = true ${filter}) as verified,
      (SELECT COUNT(*) FROM opportunity_workability ow JOIN opportunities o ON o.opportunity_id = ow.opportunity_id WHERE o.status = 'Not Submitted' ${filter}) as scored,
      (SELECT COUNT(*) FROM formulary_items) as formulary_items,
      (SELECT COUNT(*) FROM insurance_contracts) as insurance_contracts,
      (SELECT COUNT(*) FROM medicare_formulary) as medicare_formulary,
      (SELECT COUNT(*) FROM drug_pricing) as drug_pricing
  `, params);

  return result.rows[0];
}

async function getVerificationStats(pharmacyId) {
  const filter = pharmacyId ? 'AND pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE verification_success = true) as successful,
      COUNT(*) FILTER (WHERE verification_success = false) as failed,
      COUNT(*) FILTER (WHERE is_covered = true) as covered,
      COUNT(*) FILTER (WHERE is_covered = false) as not_covered,
      ROUND(AVG(response_time_ms)::NUMERIC) as avg_response
    FROM coverage_verification_log
    WHERE created_at >= NOW() - INTERVAL '7 days' ${filter}
  `, params);

  const row = result.rows[0];
  return {
    total: parseInt(row.total) || 0,
    successful: parseInt(row.successful) || 0,
    failed: parseInt(row.failed) || 0,
    covered: parseInt(row.covered) || 0,
    notCovered: parseInt(row.not_covered) || 0,
    avgResponseTime: parseInt(row.avg_response) || 0,
    successRate: row.total > 0 ? Math.round(100 * row.successful / row.total) : 0,
    coveredRate: row.successful > 0 ? Math.round(100 * row.covered / row.successful) : 0
  };
}

async function getInsuranceDataQuality(pharmacyId) {
  const filter = pharmacyId ? 'WHERE pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE contract_id IS NOT NULL) as with_contract,
      COUNT(*) FILTER (WHERE insurance_bin IS NOT NULL) as with_bin,
      COUNT(*) FILTER (WHERE contract_id ~ '^[HSR][0-9]{4}$') as medicare_part_d,
      COUNT(DISTINCT insurance_bin) as unique_bins,
      COUNT(DISTINCT contract_id) as unique_contracts
    FROM prescriptions
    ${filter}
  `, params);

  const row = result.rows[0];
  return {
    total: parseInt(row.total) || 0,
    withContractId: parseInt(row.with_contract) || 0,
    withBin: parseInt(row.with_bin) || 0,
    medicarePartD: parseInt(row.medicare_part_d) || 0,
    uniqueBins: parseInt(row.unique_bins) || 0,
    uniqueContractIds: parseInt(row.unique_contracts) || 0,
    contractIdPct: row.total > 0 ? Math.round(100 * row.with_contract / row.total) : 0,
    binPct: row.total > 0 ? Math.round(100 * row.with_bin / row.total) : 0
  };
}

async function getTopIssues(pharmacyId) {
  const filter = pharmacyId ? 'AND pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    SELECT error_message, COUNT(*) as count
    FROM coverage_verification_log
    WHERE verification_success = false
      AND created_at >= NOW() - INTERVAL '24 hours'
      ${filter}
    GROUP BY error_message
    ORDER BY count DESC
    LIMIT 5
  `, params);

  return result.rows;
}

async function getWorkabilityDistribution(pharmacyId) {
  const filter = pharmacyId ? 'AND o.pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    WITH counts AS (
      SELECT
        ow.workability_grade as grade,
        COUNT(*) as count
      FROM opportunity_workability ow
      JOIN opportunities o ON o.opportunity_id = ow.opportunity_id
      WHERE o.status = 'Not Submitted' ${filter}
      GROUP BY ow.workability_grade
    ),
    total AS (SELECT SUM(count) as total FROM counts)
    SELECT
      c.grade,
      c.count,
      ROUND(100.0 * c.count / NULLIF(t.total, 0), 1) as pct
    FROM counts c, total t
    ORDER BY c.grade
  `, params);

  return result.rows;
}

async function getSampleMissingCoverage(pharmacyId) {
  const filter = pharmacyId ? 'AND o.pharmacy_id = $1' : '';
  const params = pharmacyId ? [pharmacyId] : [];

  const result = await db.query(`
    SELECT
      o.opportunity_id,
      o.recommended_drug,
      o.recommended_ndc,
      o.annual_margin_gain,
      p.first_name || ' ' || p.last_name as patient_name
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.status = 'Not Submitted'
      AND (o.coverage_verified = false OR o.coverage_verified IS NULL)
      AND o.recommended_ndc IS NOT NULL
      ${filter}
    ORDER BY o.annual_margin_gain DESC NULLS LAST
    LIMIT 5
  `, params);

  return result.rows;
}

function generateRecommendations(dataCounts, verificationStats, insuranceQuality) {
  const recs = [];

  // Check for missing tables
  if (dataCounts.formulary_items === 0) {
    recs.push({
      severity: 'critical',
      message: 'Formulary items table is empty',
      action: 'Run migration 007_coverage_intelligence.sql and load 832 pricing files'
    });
  }

  // Check verification success rate
  if (verificationStats.total > 0 && verificationStats.successRate < 50) {
    recs.push({
      severity: 'critical',
      message: `Coverage verification success rate is only ${verificationStats.successRate}%`,
      action: 'Check CMS API connectivity and ensure prescriptions have contract_id or BIN'
    });
  } else if (verificationStats.total === 0) {
    recs.push({
      severity: 'warning',
      message: 'No coverage verifications in the last 7 days',
      action: 'Run: node run-coverage-diagnostics.js --scan'
    });
  }

  // Check insurance data quality
  if (insuranceQuality.contractIdPct < 30 && insuranceQuality.binPct < 50) {
    recs.push({
      severity: 'critical',
      message: 'Most prescriptions are missing insurance identifiers',
      action: 'Ensure claims data ingestion includes BIN, PCN, and contract_id fields'
    });
  }

  // Check workability scoring
  if (dataCounts.scored < dataCounts.opportunities * 0.5) {
    recs.push({
      severity: 'warning',
      message: 'Less than 50% of opportunities have workability scores',
      action: 'Run: node run-coverage-diagnostics.js --scan to score opportunities'
    });
  }

  // Check coverage verification
  if (dataCounts.verified < dataCounts.withNdc * 0.5) {
    recs.push({
      severity: 'warning',
      message: 'Less than 50% of opportunities with NDC have coverage verified',
      action: 'Run coverage verification scan'
    });
  }

  if (recs.length === 0) {
    recs.push({
      severity: 'info',
      message: 'System is healthy! Continue monitoring.',
      action: null
    });
  }

  return recs;
}

// Run main
main().catch(console.error);
