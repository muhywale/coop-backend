import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

const COOP_ID = 1; // adjust to whichever cooperative you're importing into

async function importMembers() {
  const fileContent = fs.readFileSync("./imports/members.csv", "utf-8");
  const records = parse(fileContent, { columns: true, skip_empty_lines: true });

  let inserted = 0;
  let skipped = [];

  for (const row of records) {
    if (!row.full_name?.trim()) {
      skipped.push({ row, reason: "Missing name" });
      continue;
    }

    try {
      await pool.query(
        `INSERT INTO members (full_name, member_number, cooperative_id) VALUES ($1, $2, $3)`,
        [row.full_name.trim(), row.member_number?.trim() || null, COOP_ID],
      );
      inserted++;
    } catch (err) {
      skipped.push({ row, reason: err.message });
    }
  }

  console.log(`Imported: ${inserted}`);
  console.log(`Skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  // eslint-disable-next-line no-undef
  process.exit(0);
}

importMembers();
