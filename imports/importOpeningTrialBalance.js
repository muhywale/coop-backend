import fs from "fs";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

async function importOpeningTrialBalance() {
  const client = await pool.connect();
  try {
    const fileContent = fs.readFileSync(
      "./imports/openingTrialBalance.csv",
      "utf-8",
    );
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
    });

    const accounts = await client.query(
      "SELECT id, code FROM chart_of_accounts",
    );
    const accountMap = {};
    accounts.rows.forEach((a) => {
      accountMap[a.code] = a.id;
    });

    const lines = [];
    let totalDebit = 0,
      totalCredit = 0;

    for (const row of records) {
      const amount = parseFloat(row.amount);
      if (!amount || amount === 0) continue;
      const accountId = accountMap[row.account_code];
      if (!accountId) {
        console.log(`Skipping unknown account code: ${row.account_code}`);
        continue;
      }
      if (row.side === "debit") {
        lines.push({ account_id: accountId, debit: amount, credit: 0 });
        totalDebit += amount;
      } else {
        lines.push({ account_id: accountId, debit: 0, credit: amount });
        totalCredit += amount;
      }
    }

    console.log(`Total debit: ${totalDebit}, Total credit: ${totalCredit}`);
    if (Math.abs(totalDebit - totalCredit) > 1) {
      console.log(
        "WARNING: does not balance — check your source Balance Sheet figures before proceeding.",
      );
      process.exit(1);
    }

    await client.query("BEGIN");
    const entryResult = await client.query(
      `INSERT INTO journal_entries (entry_date, description, source) VALUES ('2025-12-31', 'Opening balances as at 31 Dec 2025', 'opening_balance') RETURNING id`,
    );
    const entryId = entryResult.rows[0].id;
    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
        [entryId, line.account_id, line.debit, line.credit],
      );
    }
    await client.query("COMMIT");
    console.log("Opening trial balance posted successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
  } finally {
    client.release();
    // eslint-disable-next-line no-undef
    process.exit(0);
  }
}
importOpeningTrialBalance();
