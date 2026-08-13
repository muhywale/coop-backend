import pool from "../config/db.js";
import { postJournal, getDefaultCashAccount } from "../utils/journal.js";

async function backfill() {
  const client = await pool.connect();
  try {
    const cashAccountId = await getDefaultCashAccount(client);

    // Find contributions that have NO matching journal entry yet
    const contributions = await client.query(
      `SELECT c.id, c.member_id, c.amount, c.contribution_date, c.type, p.linked_account_id, p.name AS product_name
       FROM contributions c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.type IN ('savings', 'other')
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries je WHERE je.source = 'contribution' AND je.source_id = c.id
       )`,
    );

    let posted = 0,
      skipped = [];

    for (const c of contributions.rows) {
      if (!c.linked_account_id) {
        skipped.push({ id: c.id, reason: "Product has no linked account" });
        continue;
      }
      await client.query("BEGIN");
      await postJournal(client, {
        entry_date: c.contribution_date,
        description: `${c.product_name || c.type} — member ${c.member_id} (backfilled)`,
        source: "contribution",
        source_id: c.id,
        lines: [
          { account_id: cashAccountId, debit: c.amount, credit: 0 },
          { account_id: c.linked_account_id, debit: 0, credit: c.amount },
        ],
      });
      await client.query("COMMIT");
      posted++;
    }

    // Same idea for loan repayments
    const repayments = await client.query(
      `SELECT r.id, r.amount, r.repayment_date, l.product_id, p.linked_account_id
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       LEFT JOIN products p ON l.product_id = p.id
       WHERE NOT EXISTS (
         SELECT 1 FROM journal_entries je WHERE je.source = 'repayment' AND je.source_id = r.loan_id
       )`,
    );

    for (const r of repayments.rows) {
      if (!r.linked_account_id) {
        skipped.push({
          id: r.id,
          reason: "Loan product has no linked account",
        });
        continue;
      }
      await client.query("BEGIN");
      await postJournal(client, {
        entry_date: r.repayment_date,
        description: `Loan repayment (backfilled)`,
        source: "repayment",
        source_id: r.id,
        lines: [
          { account_id: cashAccountId, debit: r.amount, credit: 0 },
          { account_id: r.linked_account_id, debit: 0, credit: r.amount },
        ],
      });
      await client.query("COMMIT");
      posted++;
    }

    // Backfill loan issuances (the missing piece)
    const cashAccountId2 = cashAccountId; // reuse the one we already fetched
    const loans = await client.query(
      `SELECT l.id, l.member_id, l.principal, l.date_issued, p.linked_account_id, p.name AS product_name
       FROM loans l
       LEFT JOIN products p ON l.product_id = p.id
       WHERE NOT EXISTS (
         SELECT 1 FROM journal_entries je WHERE je.source = 'loan' AND je.source_id = l.id
       )`,
    );

    for (const l of loans.rows) {
      if (!l.linked_account_id) {
        skipped.push({
          id: l.id,
          reason: "Loan product has no linked account (issuance)",
        });
        continue;
      }
      await client.query("BEGIN");
      await postJournal(client, {
        entry_date: l.date_issued,
        description: `${l.product_name || "Loan"} issued — member ${l.member_id} (backfilled)`,
        source: "loan",
        source_id: l.id,
        lines: [
          { account_id: l.linked_account_id, debit: l.principal, credit: 0 },
          { account_id: cashAccountId2, debit: 0, credit: l.principal },
        ],
      });
      await client.query("COMMIT");
      posted++;
    }

    console.log(`Posted: ${posted}`);
    console.log(`Skipped: ${skipped.length}`);
    skipped.forEach((s) => console.log(`  - ${JSON.stringify(s)}`));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Backfill failed:", err.message);
  } finally {
    client.release();
    // eslint-disable-next-line no-undef
    process.exit(0);
  }
}

backfill();
