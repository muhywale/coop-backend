import pool from "../config/db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- helpers ----------

// Removes journal entries outright, plus any reversal entries that point at them
const purgeJournalEntries = async (client, entryIds, coopId) => {
  if (entryIds.length === 0) return 0;

  const reversals = await client.query(
    `SELECT id FROM journal_entries
     WHERE source = 'reversal' AND source_id = ANY($1::int[]) AND cooperative_id = $2`,
    [entryIds, coopId],
  );
  const allIds = [
    ...new Set([...entryIds, ...reversals.rows.map((r) => r.id)]),
  ];

  await client.query(
    "DELETE FROM journal_lines WHERE journal_entry_id = ANY($1::int[]) AND cooperative_id = $2",
    [allIds, coopId],
  );
  await client.query(
    "DELETE FROM journal_entries WHERE id = ANY($1::int[]) AND cooperative_id = $2",
    [allIds, coopId],
  );
  return allIds.length;
};

// Finds the ledger entry that was posted for a payment. Newer entries are keyed by the
// payment's own id, older ones by the member's / loan's id, so match on key + date + amount
// (+ the product's ledger account) and skip entries another record has already claimed.
const findLedgerEntry = async (
  client,
  { sources, primaryKey, altKey, coopId, dateStr, amount, accountId, claimed },
) => {
  const result = await client.query(
    `SELECT je.id
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     WHERE je.source = ANY($1::text[])
       AND je.source_id IN ($2::int, $3::int)
       AND je.cooperative_id = $4
       AND je.entry_date = $5::date
       AND NOT (je.id = ANY($6::int[]))
     GROUP BY je.id, je.source_id
     HAVING SUM(jl.debit) = $7::numeric
        AND ($8::int IS NULL OR bool_or(jl.account_id = $8::int))
     ORDER BY (je.source_id = $2::int) DESC, je.id
     LIMIT 1`,
    [sources, primaryKey, altKey, coopId, dateStr, claimed, amount, accountId],
  );
  return result.rows[0]?.id || null;
};

const findContributionEntry = (client, c, coopId, claimed = []) =>
  findLedgerEntry(client, {
    sources: ["contribution", "withdrawal"],
    primaryKey: c.id,
    altKey: c.member_id,
    coopId,
    dateStr: c.date_str,
    amount: c.amount,
    accountId: c.linked_account_id || null,
    claimed,
  });

const findRepaymentEntry = (client, r, coopId, claimed = []) =>
  findLedgerEntry(client, {
    sources: ["repayment"],
    primaryKey: r.id,
    altKey: r.loan_id,
    coopId,
    dateStr: r.date_str,
    amount: r.amount,
    accountId: r.linked_account_id || null,
    claimed,
  });

const loadContribution = async (client, id, coopId) => {
  const res = await client.query(
    `SELECT c.*, to_char(c.contribution_date, 'YYYY-MM-DD') AS date_str, p.linked_account_id
     FROM contributions c LEFT JOIN products p ON p.id = c.product_id
     WHERE c.id = $1 AND c.cooperative_id = $2`,
    [id, coopId],
  );
  return res.rows[0] || null;
};

const loadRepayment = async (client, id, coopId) => {
  const res = await client.query(
    `SELECT r.*, to_char(r.repayment_date, 'YYYY-MM-DD') AS date_str, l.member_id, p.linked_account_id
     FROM loan_repayments r
     JOIN loans l ON l.id = r.loan_id
     LEFT JOIN products p ON p.id = l.product_id
     WHERE r.id = $1 AND r.cooperative_id = $2`,
    [id, coopId],
  );
  return res.rows[0] || null;
};

// Paid or active, depending on what has been repaid now
const refreshLoanStatus = async (client, loanId, coopId) => {
  const row = await client.query(
    `SELECT l.principal, l.interest_amount,
            COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                      WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id), 0) AS repaid
     FROM loans l WHERE l.id = $1 AND l.cooperative_id = $2`,
    [loanId, coopId],
  );
  if (row.rows.length === 0) return;
  const owed =
    parseFloat(row.rows[0].principal) +
    parseFloat(row.rows[0].interest_amount || 0);
  const status =
    parseFloat(row.rows[0].repaid) >= owed - 0.005 ? "paid" : "active";
  await client.query(
    "UPDATE loans SET status = $1 WHERE id = $2 AND cooperative_id = $3",
    [status, loanId, coopId],
  );
};

// Both lines of a two-line entry move to the new amount, each staying on its own side
const setEntryAmount = async (client, entryId, coopId, amount) => {
  const lines = await client.query(
    "SELECT id, debit FROM journal_lines WHERE journal_entry_id = $1 AND cooperative_id = $2",
    [entryId, coopId],
  );
  for (const line of lines.rows) {
    const isDebit = parseFloat(line.debit) > 0;
    await client.query(
      "UPDATE journal_lines SET debit = $1, credit = $2 WHERE id = $3 AND cooperative_id = $4",
      [isDebit ? amount : 0, isDebit ? 0 : amount, line.id, coopId],
    );
  }
};

const cents = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

// ---------- deletes ----------

// DELETE /payments/contributions/:id/correct
export const correctContribution = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const contribution = await loadContribution(client, id, coopId);
    if (!contribution) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }
    if (contribution.type === "opening_balance") {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({
          error:
            "This is a carried-forward balance. Change it on the Carry Forward page instead.",
        });
    }

    const entryId = await findContributionEntry(client, contribution, coopId);
    if (entryId) await purgeJournalEntries(client, [entryId], coopId);
    await client.query(
      "DELETE FROM contributions WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );

    await client.query("COMMIT");
    res.json({
      message: entryId
        ? "Transaction deleted completely — you can now re-enter it correctly."
        : "Transaction deleted, but no matching ledger entry was found to remove.",
      original: contribution,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("correctContribution failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// DELETE /payments/repayments/:id/delete
export const deleteRepayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const repayment = await loadRepayment(client, id, coopId);
    if (!repayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Repayment not found" });
    }

    const entryId = await findRepaymentEntry(client, repayment, coopId);
    if (entryId) await purgeJournalEntries(client, [entryId], coopId);
    await client.query(
      "DELETE FROM loan_repayments WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    await refreshLoanStatus(client, repayment.loan_id, coopId);

    await client.query("COMMIT");
    res.json({
      message: entryId
        ? "Repayment deleted completely"
        : "Repayment deleted, but no matching ledger entry was found to remove.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteRepayment failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// DELETE /payments/member-day-records   body: { member_id, date }
export const deleteMemberDayRecords = async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, date } = req.body;
    const coopId = req.user.cooperativeId;

    if (!member_id || !DATE_RE.test(date || "")) {
      return res
        .status(400)
        .json({ error: "Member and a valid date are required" });
    }
    const member = await client.query(
      "SELECT id FROM members WHERE id = $1 AND cooperative_id = $2",
      [member_id, coopId],
    );
    if (member.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });

    await client.query("BEGIN");

    // Carried-forward balances are never deleted from here
    const contributions = await client.query(
      `SELECT c.*, to_char(c.contribution_date, 'YYYY-MM-DD') AS date_str, p.linked_account_id
       FROM contributions c LEFT JOIN products p ON p.id = c.product_id
       WHERE c.member_id = $1 AND c.contribution_date = $2::date AND c.cooperative_id = $3
         AND c.type <> 'opening_balance'`,
      [member_id, date, coopId],
    );
    const repayments = await client.query(
      `SELECT r.*, to_char(r.repayment_date, 'YYYY-MM-DD') AS date_str, l.member_id, p.linked_account_id
       FROM loan_repayments r
       JOIN loans l ON l.id = r.loan_id
       LEFT JOIN products p ON p.id = l.product_id
       WHERE l.member_id = $1 AND r.repayment_date = $2::date AND r.cooperative_id = $3`,
      [member_id, date, coopId],
    );

    const entryIds = [];
    let missing = 0;
    for (const c of contributions.rows) {
      const entryId = await findContributionEntry(client, c, coopId, entryIds);
      if (entryId) entryIds.push(entryId);
      else missing++;
    }
    for (const r of repayments.rows) {
      const entryId = await findRepaymentEntry(client, r, coopId, entryIds);
      if (entryId) entryIds.push(entryId);
      else missing++;
    }

    await purgeJournalEntries(client, entryIds, coopId);

    if (contributions.rows.length > 0) {
      await client.query(
        "DELETE FROM contributions WHERE id = ANY($1::int[]) AND cooperative_id = $2",
        [contributions.rows.map((c) => c.id), coopId],
      );
    }
    if (repayments.rows.length > 0) {
      await client.query(
        "DELETE FROM loan_repayments WHERE id = ANY($1::int[]) AND cooperative_id = $2",
        [repayments.rows.map((r) => r.id), coopId],
      );
    }
    for (const loanId of new Set(repayments.rows.map((r) => r.loan_id))) {
      await refreshLoanStatus(client, loanId, coopId);
    }

    await client.query("COMMIT");

    const total = contributions.rows.length + repayments.rows.length;
    res.json({
      message:
        total === 0
          ? "No records found for this member on that date"
          : `Deleted ${total} record(s) for this member on ${date}${missing > 0 ? ` (${missing} had no matching ledger entry)` : ""}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteMemberDayRecords failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// ---------- edits (same matcher, so they hit the right ledger entry) ----------

// PUT /payments/contributions/:id/edit-amount
export const editContributionAmount = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    const amount = cents(req.body.new_amount);

    if (amount <= 0) {
      return res
        .status(400)
        .json({
          error:
            "Enter an amount greater than zero. Use Delete to remove this entry entirely.",
        });
    }

    await client.query("BEGIN");

    const contribution = await loadContribution(client, id, coopId);
    if (!contribution) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Match against the OLD amount, before changing it
    const isOpening = contribution.type === "opening_balance";
    const entryId = isOpening
      ? null
      : await findContributionEntry(client, contribution, coopId);

    await client.query(
      "UPDATE contributions SET amount = $1 WHERE id = $2 AND cooperative_id = $3",
      [amount, id, coopId],
    );
    if (entryId) await setEntryAmount(client, entryId, coopId, amount);

    await client.query("COMMIT");
    res.json({
      message: `Amount updated to ₦${amount.toLocaleString()}${!entryId && !isOpening ? " — no matching ledger entry was found, so only the payment record changed" : ""}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("editContributionAmount failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// PUT /payments/repayments/:id/edit-amount
export const editRepaymentAmount = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    const amount = cents(req.body.new_amount);

    if (amount <= 0) {
      return res
        .status(400)
        .json({
          error:
            "Enter an amount greater than zero. Use Delete to remove this entry entirely.",
        });
    }

    await client.query("BEGIN");

    const repayment = await loadRepayment(client, id, coopId);
    if (!repayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Repayment not found" });
    }

    const entryId = await findRepaymentEntry(client, repayment, coopId);

    await client.query(
      "UPDATE loan_repayments SET amount = $1 WHERE id = $2 AND cooperative_id = $3",
      [amount, id, coopId],
    );
    if (entryId) await setEntryAmount(client, entryId, coopId, amount);
    await refreshLoanStatus(client, repayment.loan_id, coopId);

    await client.query("COMMIT");
    res.json({
      message: `Repayment updated to ₦${amount.toLocaleString()}${!entryId ? " — no matching ledger entry was found, so only the repayment record changed" : ""}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("editRepaymentAmount failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
