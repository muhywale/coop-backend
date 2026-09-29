import pool from "../config/db.js";
import { postJournal, getDefaultCashAccount } from "../utils/journal.js";

// GET all loans
export const getLoans = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, m.full_name, m.member_number, p.name AS product_name,
              (l.principal + l.interest_amount) - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN members m ON l.member_id = m.id
       LEFT JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.cooperative_id = $1
       GROUP BY l.id, m.full_name, m.member_number, p.name
       ORDER BY l.date_issued DESC`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// GET loans for a specific member (admin, by ID in URL)
export const getLoansByMemberId = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query(
      `SELECT l.*, p.name AS product_name,
              (l.principal + l.interest_amount) - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       LEFT JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2
       GROUP BY l.id, p.name
       ORDER BY l.date_issued DESC`,
      [memberId, req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// GET the logged-in member's own loans
export const getLoansByMember = async (req, res) => {
  req.params.memberId = req.user.memberId;
  return getLoansByMemberId(req, res);
};

// POST create new loan
export const createLoan = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      member_id,
      principal,
      product_id,
      duration_value,
      duration_unit,
      date_issued,
    } = req.body;
    const coopId = req.user.cooperativeId;

    if (!principal || parseFloat(principal) <= 0) {
      return res.status(400).json({ error: "Enter a valid principal amount" });
    }

    // Use the date sent by the form; fall back to today only if missing
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(date_issued || "")
      ? date_issued
      : today;

    await client.query("BEGIN");

    const member = await client.query(
      "SELECT id FROM members WHERE id = $1 AND cooperative_id = $2",
      [member_id, coopId],
    );
    if (member.rows.length === 0) throw new Error("Member not found");

    const product = await client.query(
      "SELECT * FROM products WHERE id = $1 AND cooperative_id = $2",
      [product_id, coopId],
    );
    if (product.rows.length === 0) throw new Error("Product not found");
    const { interest_rate, interest_type, linked_account_id } = product.rows[0];

    const interestAmount =
      interest_type === "one_off"
        ? (parseFloat(principal) * parseFloat(interest_rate || 0)) / 100
        : 0;

    const result = await client.query(
      `INSERT INTO loans (member_id, principal, interest_rate, interest_amount, date_issued, status, product_id, cooperative_id, duration_value, duration_unit)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9) RETURNING *`,
      [
        member_id,
        principal,
        interest_rate,
        interestAmount,
        issueDate,
        product_id,
        coopId,
        duration_value || null,
        duration_unit || "months",
      ],
    );
    const newLoanId = result.rows[0].id;

    const cashAccountId = await getDefaultCashAccount(client, coopId);
    if (linked_account_id) {
      await postJournal(client, {
        entry_date: issueDate,
        description: `Loan issued — member ${member_id}`,
        source: "loan",
        source_id: newLoanId,
        cooperativeId: coopId,
        lines: [
          { account_id: linked_account_id, debit: principal, credit: 0 },
          { account_id: cashAccountId, debit: 0, credit: principal },
        ],
      });

      if (interestAmount > 0) {
        const interestIncomeAccount = await client.query(
          `SELECT id FROM chart_of_accounts WHERE code = '4000' AND cooperative_id = $1`,
          [coopId],
        );
        if (interestIncomeAccount.rows.length > 0) {
          await postJournal(client, {
            entry_date: issueDate,
            description: `Loan interest (one-off) — loan #${newLoanId}`,
            source: "loan_interest",
            source_id: newLoanId,
            cooperativeId: coopId,
            lines: [
              {
                account_id: linked_account_id,
                debit: interestAmount,
                credit: 0,
              },
              {
                account_id: interestIncomeAccount.rows[0].id,
                debit: 0,
                credit: interestAmount,
              },
            ],
          });
        }
      }
    }

    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// POST record a repayment against a loan
export const recordRepayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { loanId } = req.params;
    const { amount } = req.body;
    const coopId = req.user.cooperativeId;

    await client.query("BEGIN");

    const repayment = await client.query(
      `INSERT INTO loan_repayments (loan_id, amount, cooperative_id) VALUES ($1, $2, $3) RETURNING *`,
      [loanId, amount, coopId],
    );

    const totals = await client.query(
      `SELECT l.principal, l.interest_amount, COALESCE(SUM(r.amount), 0) AS total_repaid
       FROM loans l
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.id = $1 AND l.cooperative_id = $2
       GROUP BY l.principal, l.interest_amount`,
      [loanId, coopId],
    );

    const { principal, interest_amount, total_repaid } = totals.rows[0];
    const totalOwed = parseFloat(principal) + parseFloat(interest_amount || 0);
    if (parseFloat(total_repaid) >= totalOwed) {
      await client.query(
        `UPDATE loans SET status = 'paid' WHERE id = $1 AND cooperative_id = $2`,
        [loanId, coopId],
      );
    }

    await client.query("COMMIT");
    res.status(201).json(repayment.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
};

// Posts the mirror-image of an existing journal entry, dated the same as the original
const reverseJournalEntry = async (client, entryId, coopId, description) => {
  const original = await client.query(
    "SELECT entry_date FROM journal_entries WHERE id = $1 AND cooperative_id = $2",
    [entryId, coopId],
  );
  const lines = await client.query(
    "SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id = $1 AND cooperative_id = $2",
    [entryId, coopId],
  );
  const reversal = await client.query(
    `INSERT INTO journal_entries (entry_date, description, source, source_id, cooperative_id)
     VALUES ($1, $2, 'reversal', $3, $4) RETURNING id`,
    [original.rows[0].entry_date, description, entryId, coopId],
  );
  for (const line of lines.rows) {
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, cooperative_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [reversal.rows[0].id, line.account_id, line.credit, line.debit, coopId],
    );
  }
};

export const deleteLoan = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const loan = await client.query(
      "SELECT id FROM loans WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    if (loan.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loan not found" });
    }

    const description = `Deleted loan #${id}`;

    // 1. Issuance + interest entries (always keyed by the loan's own id)
    const loanEntries = await client.query(
      `SELECT je.id FROM journal_entries je
       WHERE je.source IN ('loan', 'loan_interest') AND je.source_id = $1 AND je.cooperative_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries rev
           WHERE rev.source = 'reversal' AND rev.source_id = je.id AND rev.cooperative_id = $2
         )`,
      [id, coopId],
    );
    for (const entry of loanEntries.rows) {
      await reverseJournalEntry(client, entry.id, coopId, description);
    }

    // 2. Repayment entries — older ones are keyed by loan id, newer ones by repayment id,
    //    so match on key + date + amount to avoid touching anyone else's entries
    const repayments = await client.query(
      "SELECT id FROM loan_repayments WHERE loan_id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    const usedEntryIds = [];
    let unmatched = 0;
    for (const r of repayments.rows) {
      const match = await client.query(
        `SELECT je.id
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN loan_repayments r ON r.id = $1
         WHERE je.source = 'repayment' AND je.source_id IN (r.id, r.loan_id)
           AND je.cooperative_id = $2 AND je.entry_date = r.repayment_date
           AND NOT (je.id = ANY($3::int[]))
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries rev
             WHERE rev.source = 'reversal' AND rev.source_id = je.id AND rev.cooperative_id = $2
           )
         GROUP BY je.id, r.amount
         HAVING SUM(jl.debit) = r.amount
         LIMIT 1`,
        [r.id, coopId, usedEntryIds],
      );
      if (match.rows.length > 0) {
        await reverseJournalEntry(
          client,
          match.rows[0].id,
          coopId,
          description,
        );
        usedEntryIds.push(match.rows[0].id);
      } else {
        unmatched++;
      }
    }

    await client.query(
      "DELETE FROM loan_repayments WHERE loan_id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    await client.query(
      "DELETE FROM loans WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );

    await client.query("COMMIT");
    res.json({
      message: `Loan deleted${unmatched > 0 ? ` (${unmatched} repayment(s) had no matching ledger entry to reverse)` : ""}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// GET repayment history for a loan
export const getRepayments = async (req, res) => {
  try {
    const { loanId } = req.params;
    const result = await pool.query(
      "SELECT * FROM loan_repayments WHERE loan_id = $1 AND cooperative_id = $2 ORDER BY repayment_date",
      [loanId, req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST run monthly interest accrual for reducing-balance loans
export const runInterestAccrual = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const { as_at_date } = req.body;

    await client.query("BEGIN");

    const activeLoans = await client.query(
      `SELECT l.id, l.principal, l.interest_rate, p.linked_account_id
       FROM loans l JOIN products p ON l.product_id = p.id
       WHERE l.status = 'active' AND p.interest_type = 'reducing_balance' AND l.cooperative_id = $1`,
      [coopId],
    );

    let accrued = 0;
    const interestIncomeAccount = await client.query(
      `SELECT id FROM chart_of_accounts WHERE code = '4000' AND cooperative_id = $1`,
      [coopId],
    );
    const interestAccountId = interestIncomeAccount.rows[0]?.id;

    for (const loan of activeLoans.rows) {
      const repayTotals = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_repaid FROM loan_repayments WHERE loan_id = $1`,
        [loan.id],
      );
      const outstandingPrincipal =
        parseFloat(loan.principal) -
        parseFloat(repayTotals.rows[0].total_repaid);
      if (outstandingPrincipal <= 0) continue;

      const monthlyInterest =
        (outstandingPrincipal * parseFloat(loan.interest_rate || 0)) / 100 / 12;
      if (monthlyInterest <= 0) continue;

      if (interestAccountId && loan.linked_account_id) {
        await postJournal(client, {
          entry_date: as_at_date,
          description: `Monthly interest accrual — loan #${loan.id}`,
          source: "loan_interest",
          source_id: loan.id,
          cooperativeId: coopId,
          lines: [
            {
              account_id: loan.linked_account_id,
              debit: monthlyInterest,
              credit: 0,
            },
            {
              account_id: interestAccountId,
              debit: 0,
              credit: monthlyInterest,
            },
          ],
        });

        await client.query(
          `UPDATE loans SET interest_amount = interest_amount + $1 WHERE id = $2`,
          [monthlyInterest, loan.id],
        );
        accrued++;
      }
    }

    await client.query("COMMIT");
    res.json({ message: `Interest accrued on ${accrued} loans` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const getLoanPerformanceReport = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;

    const result = await pool.query(
      `SELECT l.id, l.member_id, m.full_name, m.member_number, p.name AS product_name,
              l.principal, l.interest_amount, l.date_issued, l.status,
              l.duration_value, l.duration_unit,
              (l.principal + l.interest_amount) - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN members m ON l.member_id = m.id
       JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.cooperative_id = $1
       GROUP BY l.id, m.full_name, m.member_number, p.name
       ORDER BY l.date_issued DESC`,
      [coopId],
    );

    const today = new Date();

    const rows = result.rows.map((loan) => {
      const issued = new Date(loan.date_issued);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysElapsed = Math.floor((today - issued) / msPerDay);

      const unit = loan.duration_unit || "months";
      const elapsed =
        unit === "weeks"
          ? Math.floor(daysElapsed / 7)
          : Math.floor(daysElapsed / 30);
      const totalDuration = loan.duration_value || null;
      const remaining = totalDuration !== null ? totalDuration - elapsed : null;

      let remark;
      const outstanding = parseFloat(loan.outstanding_balance);

      if (outstanding <= 0 || loan.status === "paid") {
        remark = "Completed";
      } else if (totalDuration === null) {
        remark = "No duration set";
      } else if (remaining < 0) {
        remark = "Default";
      } else {
        // Rough on-track check: has the member repaid at least proportional to elapsed time?
        const expectedRepaidRatio =
          totalDuration > 0 ? elapsed / totalDuration : 0;
        const totalOwed =
          parseFloat(loan.principal) + parseFloat(loan.interest_amount || 0);
        const actualRepaidRatio =
          totalOwed > 0 ? (totalOwed - outstanding) / totalOwed : 0;

        remark =
          actualRepaidRatio >= expectedRepaidRatio * 0.8
            ? "Performing well"
            : "Behind schedule";
      }

      return {
        ...loan,
        elapsed,
        remaining,
        unit,
        remark,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const editLoan = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { principal, product_id, duration_value, duration_unit } = req.body;
    const coopId = req.user.cooperativeId;

    if (!principal || parseFloat(principal) <= 0) {
      return res.status(400).json({ error: "Enter a valid principal amount" });
    }

    await client.query("BEGIN");

    const existingLoan = await client.query(
      "SELECT * FROM loans WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    if (existingLoan.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loan not found" });
    }
    const oldLoan = existingLoan.rows[0];

    // Fetch the new product's details (may be the same product, or a genuine type change)
    const newProduct = await client.query(
      "SELECT * FROM products WHERE id = $1 AND cooperative_id = $2",
      [product_id, coopId],
    );
    if (newProduct.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Selected loan product not found" });
    }
    const {
      interest_rate,
      interest_type,
      linked_account_id: newAccountId,
    } = newProduct.rows[0];

    // Recalculate one-off interest against the new principal/product, since either may have changed
    const newInterestAmount =
      interest_type === "one_off"
        ? (parseFloat(principal) * parseFloat(interest_rate || 0)) / 100
        : parseFloat(oldLoan.interest_amount || 0); // reducing-balance loans keep whatever's already accrued

    // Update the loan record itself
    await client.query(
      `UPDATE loans SET principal = $1, product_id = $2, interest_rate = $3, interest_amount = $4,
       duration_value = $5, duration_unit = $6
       WHERE id = $7 AND cooperative_id = $8`,
      [
        principal,
        product_id,
        interest_rate,
        newInterestAmount,
        duration_value || null,
        duration_unit || "months",
        id,
        coopId,
      ],
    );

    // Re-adjust the ORIGINAL issuance journal entry to reflect the new principal / account
    const journalEntry = await client.query(
      `SELECT id FROM journal_entries WHERE source = 'loan' AND source_id = $1 AND cooperative_id = $2`,
      [id, coopId],
    );
    if (journalEntry.rows.length > 0) {
      const entryId = journalEntry.rows[0].id;
      const lines = await client.query(
        "SELECT * FROM journal_lines WHERE journal_entry_id = $1 AND cooperative_id = $2",
        [entryId, coopId],
      );
      for (const line of lines.rows) {
        // The line touching the OLD loan account gets repointed to the NEW loan account (if product changed)
        // and both lines get rescaled to the new principal
        const wasLoanAccountSide = parseFloat(line.debit) > 0; // loan account was debited at issuance
        if (wasLoanAccountSide) {
          await client.query(
            "UPDATE journal_lines SET account_id = $1, debit = $2, credit = 0 WHERE id = $3",
            [newAccountId, principal, line.id],
          );
        } else {
          await client.query(
            "UPDATE journal_lines SET debit = 0, credit = $1 WHERE id = $2",
            [principal, line.id],
          );
        }
      }
    }

    // Also adjust the one-off interest journal entry, if one exists, to match the recalculated amount
    const interestEntry = await client.query(
      `SELECT id FROM journal_entries WHERE source = 'loan_interest' AND source_id = $1 AND cooperative_id = $2`,
      [id, coopId],
    );
    if (interestEntry.rows.length > 0 && interest_type === "one_off") {
      const entryId = interestEntry.rows[0].id;
      const lines = await client.query(
        "SELECT * FROM journal_lines WHERE journal_entry_id = $1 AND cooperative_id = $2",
        [entryId, coopId],
      );
      for (const line of lines.rows) {
        const wasDebit = parseFloat(line.debit) > 0;
        if (wasDebit) {
          await client.query(
            "UPDATE journal_lines SET account_id = $1, debit = $2, credit = 0 WHERE id = $3",
            [newAccountId, newInterestAmount, line.id],
          );
        } else {
          await client.query(
            "UPDATE journal_lines SET debit = 0, credit = $1 WHERE id = $2",
            [newInterestAmount, line.id],
          );
        }
      }
    }

    // Re-check status now that principal/interest may have changed
    const totals = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_repaid FROM loan_repayments WHERE loan_id = $1`,
      [id],
    );
    const totalOwed = parseFloat(principal) + parseFloat(newInterestAmount);
    const totalRepaid = parseFloat(totals.rows[0].total_repaid);
    const newStatus = totalRepaid >= totalOwed ? "paid" : "active";

    await client.query(
      `UPDATE loans SET status = $1 WHERE id = $2 AND cooperative_id = $3`,
      [newStatus, id, coopId],
    );

    await client.query("COMMIT");
    res.json({
      message: `Loan updated successfully${newStatus === "paid" ? " — now fully paid" : ""}`,
    });
    await client.query("COMMIT");
    res.json({ message: "Loan updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
