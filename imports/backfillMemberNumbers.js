// coop-backend/imports/backfillMemberNumbers.js
import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

const COOP_ID = 1;

async function backfillNumbers() {
  let fileContent = fs.readFileSync("./imports/members.csv", "utf-8");

  if (fileContent.charCodeAt(0) === 0xfeff) {
    fileContent = fileContent.slice(1);
  }
  const records = parse(fileContent, { columns: true, skip_empty_lines: true });
  console.log("Total records found:", records.length);
  console.log("First record:", records[0]);

  let updated = 0;
  const skipped = [];

  for (const row of records) {
    if (!row.member_number?.trim() || !row.full_name?.trim()) continue;

    const result = await pool.query(
      `UPDATE members SET member_number = $1 WHERE full_name = $2 AND cooperative_id = $3 RETURNING id`,
      [row.member_number.trim(), row.full_name.trim(), COOP_ID],
    );

    if (result.rows.length === 0) {
      skipped.push({ name: row.full_name, reason: "No matching member found" });
    } else {
      updated++;
    }
  }

  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  // eslint-disable-next-line no-undef
  process.exit(0);
}

backfillNumbers();
