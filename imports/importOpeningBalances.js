import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

async function importOpeningBalances() {
  const fileContent = fs.readFileSync("./imports/openingBalances.csv", "utf-8");
  const records = parse(fileContent, { columns: true, skip_empty_lines: true });

  const members = await pool.query("SELECT id, full_name FROM members");
  const memberMap = {};
  members.rows.forEach((m) => {
    memberMap[m.full_name.trim().toLowerCase()] = m.id;
  });

  const products = await pool.query("SELECT id, name FROM products");
  const productMap = {};
  products.rows.forEach((p) => {
    productMap[p.name.trim().toLowerCase()] = p.id;
  });

  let inserted = 0,
    skipped = [];
  for (const row of records) {
    const memberId = memberMap[row.member_name?.trim().toLowerCase()];
    const productId = productMap[row.product_name?.trim().toLowerCase()];
    const amount = parseFloat(row.amount);

    if (!memberId) {
      skipped.push({ row, reason: "Member not found" });
      continue;
    }
    if (!productId) {
      skipped.push({ row, reason: "Product not found" });
      continue;
    }
    if (!amount || amount <= 0) continue;

    await pool.query(
      `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id)
       VALUES ($1, $2, 'opening_balance', '2025-12-31', 'Opening balance as at 2025', $3)`,
      [memberId, amount, productId],
    );
    inserted++;
  }
  console.log(`Inserted: ${inserted}, Skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  // eslint-disable-next-line no-undef
  process.exit(0);
}
importOpeningBalances();
