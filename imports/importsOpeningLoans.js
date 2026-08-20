// coop-backend/imports/importOpeningLoans.js
import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

async function importOpeningLoans() {
  const fileContent = fs.readFileSync("./imports/openingLoans.csv", "utf-8");
  const records = parse(fileContent, { columns: true, skip_empty_lines: true });

  const members = await pool.query("SELECT id, full_name FROM members");
  const memberMap = {};
  members.rows.forEach((m) => {
    memberMap[m.full_name.trim().toLowerCase()] = m.id;
  });

  const defaultLoanProduct = await pool.query(
    `SELECT id FROM products WHERE category = 'loan' LIMIT 1`,
  );
  const productId = defaultLoanProduct.rows[0]?.id;

  let inserted = 0,
    skipped = [];
  for (const row of records) {
    const memberId = memberMap[row.member_name?.trim().toLowerCase()];
    const amount = parseFloat(row.amount);
    if (!memberId) {
      skipped.push({ row, reason: "Member not found" });
      continue;
    }
    if (!amount || amount <= 0) continue;

    await pool.query(
      `INSERT INTO loans (member_id, principal, interest_rate, date_issued, status, product_id)
       VALUES ($1, $2, 0, '2025-12-31', 'active', $3)`,
      [memberId, amount, productId],
    );
    inserted++;
  }
  console.log(`Inserted: ${inserted}, Skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  // eslint-disable-next-line no-undef
  process.exit(0);
}
importOpeningLoans();
