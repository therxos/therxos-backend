import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function run() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      WITH classified AS (
        SELECT
          ndc,
          drug_name,
          insurance_bin,
          insurance_group,
          quantity_dispensed,
          days_supply,
          dispensed_date,
          insurance_pay,
          patient_pay,
          acquisition_cost,
          CASE
            WHEN LOWER(drug_name) ~ '(lancet|microlet|unistik)' THEN 'Lancets'
            WHEN LOWER(drug_name) ~ '(swab|alcohol prep|prep pad)'
              AND LOWER(drug_name) NOT LIKE '%clindamycin%'
              AND LOWER(drug_name) NOT LIKE '%qbrexza%'
              THEN 'Swabs'
            WHEN LOWER(drug_name) ~ '(pen needle|pen ndl|pen needles|novofine|novotwist|nano pen|bd nano|comfort ez.*pen|comfort ez.*ndl|comfort ez.*32g|comfort ez.*31g|easy comfort pen|easy touch pen|5-bevel pen)'
              AND LOWER(drug_name) NOT LIKE '%insulin%'
              THEN 'Pen Needles'
            WHEN LOWER(drug_name) ~ '(insulin syr|insulin syrg|syringe insulin|comfort ez insulin)'
              THEN 'Insulin Syringes'
            WHEN LOWER(drug_name) ~ '(test strip|blood glucose strip|freestyle.*strip|onetouch.*strip|one touch.*strip|contour.*strip|accu.chek.*strip|true.?metrix.*strip|prodigy.*strip|relion.*strip|embrace.*strip)'
              THEN 'Test Strips'
            WHEN LOWER(drug_name) ~ '(glucometer|glucose meter|blood glucose monitor|true metrix.*kit|true metrix.*meter|onetouch.*kit|contour.*kit|accu.chek.*kit|freestyle.*kit)'
              AND LOWER(drug_name) NOT LIKE '%test strip%'
              AND LOWER(drug_name) NOT LIKE '%sensor%'
              AND LOWER(drug_name) NOT LIKE '%libre%'
              AND LOWER(drug_name) NOT LIKE '%freestyle lb%'
              AND LOWER(drug_name) NOT LIKE '%salmeterol%'
              AND LOWER(drug_name) NOT LIKE '%fluticasone%'
              AND LOWER(drug_name) NOT LIKE '%asmanex%'
              AND LOWER(drug_name) NOT LIKE '%metered%'
              THEN 'Glucometers'
            ELSE NULL
          END as supply_type,
          -- GP: pull from raw_data profit fields (all known variations), fall back to Price - Cost, then columns
          COALESCE(
            NULLIF((raw_data->>'gross_profit')::numeric, 0),
            NULLIF((raw_data->>'Gross Profit')::numeric, 0),
            NULLIF((raw_data->>'grossprofit')::numeric, 0),
            NULLIF((raw_data->>'GrossProfit')::numeric, 0),
            NULLIF((raw_data->>'net_profit')::numeric, 0),
            NULLIF((raw_data->>'Net Profit')::numeric, 0),
            NULLIF((raw_data->>'netprofit')::numeric, 0),
            NULLIF((raw_data->>'NetProfit')::numeric, 0),
            NULLIF((raw_data->>'adj_profit')::numeric, 0),
            NULLIF((raw_data->>'Adj Profit')::numeric, 0),
            NULLIF((raw_data->>'adjprofit')::numeric, 0),
            NULLIF((raw_data->>'AdjProfit')::numeric, 0),
            NULLIF((raw_data->>'Adjusted Profit')::numeric, 0),
            NULLIF((raw_data->>'adjusted_profit')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE(insurance_pay,0) + COALESCE(patient_pay,0) - COALESCE(acquisition_cost,0)
          ) as gp_raw
        FROM prescriptions
        WHERE insurance_bin IN ('610097','610014','610011','610494','003858','015581','004336','610502')
          AND dispensed_date >= '2025-09-01'
          AND COALESCE(insurance_group, '') NOT ILIKE '%rxlocal%'
          AND COALESCE(insurance_group, '') != ''
          AND COALESCE(insurance_group, '') != 'No Group Number'
          AND (
            LOWER(drug_name) ~ '(lancet|microlet|unistik)'
            OR LOWER(drug_name) ~ '(swab|alcohol prep|prep pad)'
            OR LOWER(drug_name) ~ '(pen needle|pen ndl|pen needles|novofine|novotwist|nano pen|bd nano|comfort ez.*pen|comfort ez.*ndl|comfort ez.*32g|comfort ez.*31g|easy comfort pen|easy touch pen|5-bevel pen)'
            OR LOWER(drug_name) ~ '(insulin syr|insulin syrg|syringe insulin|comfort ez insulin)'
            OR LOWER(drug_name) ~ '(test strip|blood glucose strip|freestyle.*strip|onetouch.*strip|one touch.*strip|contour.*strip|accu.chek.*strip|true.?metrix.*strip|prodigy.*strip|relion.*strip|embrace.*strip)'
            OR (LOWER(drug_name) ~ '(glucometer|glucose meter|blood glucose monitor|true metrix.*kit|true metrix.*meter|onetouch.*kit|contour.*kit|accu.chek.*kit|freestyle.*kit)'
                AND LOWER(drug_name) NOT LIKE '%sensor%'
                AND LOWER(drug_name) NOT LIKE '%libre%'
                AND LOWER(drug_name) NOT LIKE '%freestyle lb%')
          )
          AND LOWER(drug_name) NOT LIKE '%clindamycin%'
          AND LOWER(drug_name) NOT LIKE '%qbrexza%'
          AND LOWER(drug_name) NOT LIKE '%salmeterol%'
          AND LOWER(drug_name) NOT LIKE '%fluticasone%'
          AND LOWER(drug_name) NOT LIKE '%asmanex%'
          AND LOWER(drug_name) NOT LIKE '%metered%'
      ),

      -- Step 1: For each supply_type + BIN + GROUP + NDC, get the most recent claim
      latest_per_ndc AS (
        SELECT *,
          -- Normalize GP per 100 units for supplies sold by box
          -- If qty is 0 or null, assume 100 (1 box)
          CASE
            WHEN supply_type IN ('Lancets','Pen Needles','Insulin Syringes','Swabs')
              THEN gp_raw / GREATEST(COALESCE(NULLIF(quantity_dispensed, 0), 100) / 100.0, 1)
            WHEN supply_type = 'Test Strips'
              THEN gp_raw / GREATEST(COALESCE(NULLIF(quantity_dispensed, 0), 100) / 100.0, 1)
            ELSE gp_raw
          END as gp_per_box,
          ROW_NUMBER() OVER (
            PARTITION BY supply_type, insurance_bin, insurance_group, ndc
            ORDER BY dispensed_date DESC
          ) as rn_ndc
        FROM classified
        WHERE supply_type IS NOT NULL
      ),

      -- Step 2: Keep only the most recent claim per NDC per BIN/GROUP
      recent_claims AS (
        SELECT * FROM latest_per_ndc WHERE rn_ndc = 1
      ),

      -- Step 3: Rank NDCs within each BIN/GROUP by GP per box (highest first)
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY supply_type, insurance_bin, insurance_group
            ORDER BY gp_per_box DESC
          ) as rank
        FROM recent_claims
      )

      SELECT
        supply_type,
        insurance_bin as bin,
        insurance_group as grp,
        ndc,
        drug_name,
        ROUND(gp_raw::numeric, 2) as gp_claim,
        ROUND(gp_per_box::numeric, 2) as gp_per_100,
        quantity_dispensed as qty,
        days_supply as ds,
        dispensed_date,
        ROUND(insurance_pay::numeric, 2) as ins_pay,
        ROUND(patient_pay::numeric, 2) as pt_pay,
        ROUND(COALESCE(acquisition_cost, 0)::numeric, 2) as acq_cost,
        rank
      FROM ranked
      WHERE rank = 1 AND gp_per_box >= 10
      ORDER BY supply_type, insurance_bin, insurance_group, rank
    `);

    if (result.rows.length === 0) {
      console.log('No paid diabetic supply claims found.');
      client.release();
      await pool.end();
      return;
    }

    const types = ['Test Strips', 'Lancets', 'Pen Needles', 'Insulin Syringes', 'Swabs', 'Glucometers'];

    for (const type of types) {
      const rows = result.rows.filter(r => r.supply_type === type);
      if (rows.length === 0) continue;

      const binGroups = [...new Set(rows.map(r => r.bin + '|' + r.grp))];

      console.log(`\n${'='.repeat(130)}`);
      console.log(`  ${type.toUpperCase()} - Top NDCs per BIN/GROUP by GP/100 | Most Recent Paid Claim | Since 09/01/2025`);
      console.log(`  ${binGroups.length} BIN/GROUP combos`);
      console.log(`${'='.repeat(130)}`);
      console.log(
        '#'.padEnd(3) +
        'BIN'.padEnd(10) +
        'GROUP'.padEnd(16) +
        'NDC'.padEnd(14) +
        'Drug Name'.padEnd(40) +
        'GP/100'.padEnd(11) +
        'GP(claim)'.padEnd(11) +
        'Qty'.padEnd(7) +
        'DS'.padEnd(5) +
        'Date'.padEnd(12)
      );
      console.log('-'.repeat(130));

      let lastBinGrp = '';
      for (const r of rows) {
        const curBinGrp = r.bin + '|' + r.grp;
        if (curBinGrp !== lastBinGrp && lastBinGrp !== '') {
          console.log('');  // blank line between BIN/GROUP combos
        }
        lastBinGrp = curBinGrp;

        const gpBoxStr = r.gp_per_100 >= 0 ? `$${r.gp_per_100}` : `-$${Math.abs(r.gp_per_100)}`;
        const gpClaimStr = r.gp_claim >= 0 ? `$${r.gp_claim}` : `-$${Math.abs(r.gp_claim)}`;
        const marker = r.rank == 1 ? '>>>' : '   ';

        console.log(
          marker.padEnd(3) +
          (r.bin || '').padEnd(10) +
          (r.grp || '').substring(0, 14).padEnd(16) +
          (r.ndc || '').padEnd(14) +
          (r.drug_name || '').substring(0, 38).padEnd(40) +
          gpBoxStr.padEnd(11) +
          gpClaimStr.padEnd(11) +
          String(r.qty || 0).padEnd(7) +
          String(r.ds || 'N/A').padEnd(5) +
          (r.dispensed_date ? new Date(r.dispensed_date).toISOString().slice(0, 10) : 'N/A')
        );
      }
    }

    // Summary: just the #1 per BIN/GROUP
    console.log(`\n${'='.repeat(60)}`);
    console.log('  SUMMARY');
    console.log(`${'='.repeat(60)}`);
    for (const type of types) {
      const top1 = result.rows.filter(r => r.supply_type === type && r.rank == 1);
      console.log(`  ${type.padEnd(22)} ${top1.length} BIN/GROUP combos`);
    }
    const allTop1 = result.rows.filter(r => r.rank == 1);
    console.log(`  ${'TOTAL'.padEnd(22)} ${allTop1.length} BIN/GROUP combos`);

    // Export to CSV
    const csvHeader = 'Rank,Supply Type,BIN,GROUP,NDC,Drug Name,GP/100,GP (Claim),Qty,Days Supply,Dispensed Date,Ins Pay,Pt Pay,Acq Cost';
    const csvRows = result.rows.map(r => {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [
        r.rank,
        esc(r.supply_type),
        esc(r.bin),
        esc(r.grp),
        esc(r.ndc),
        esc(r.drug_name),
        r.gp_per_100,
        r.gp_claim,
        r.qty,
        r.ds ?? '',
        r.dispensed_date ? new Date(r.dispensed_date).toISOString().slice(0, 10) : '',
        r.ins_pay ?? '',
        r.pt_pay ?? '',
        r.acq_cost ?? ''
      ].join(',');
    });
    const csvPath = new URL('diabetic-supplies-top-ndc.csv', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    fs.writeFileSync(csvPath, csvHeader + '\n' + csvRows.join('\n'), 'utf8');
    console.log(`\nCSV exported to: ${csvPath}`);

  } catch (err) {
    console.error('Query error:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
