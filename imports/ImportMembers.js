import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

async function importMembers() {
  const fileContent = fs.readFileSync("./imports/members.csv", "utf-8");
  const records = parse(fileContent, { columns: true, skip_empty_lines: true });

  let inserted = 0,
    skipped = [];
  for (const row of records) {
    if (!row.full_name?.trim()) {
      skipped.push(row);
      continue;
    }
    try {
      await pool.query(`INSERT INTO members (full_name) VALUES ($1)`, [
        row.full_name.trim(),
      ]);
      inserted++;
    } catch (err) {
      skipped.push({ row, reason: err.message });
    }
  }
  console.log(`Imported: ${inserted}, Skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  // eslint-disable-next-line no-undef
  process.exit(0);
}
importMembers();
