import { postJournal, getDefaultCashAccount } from "../utils/journal.js";
import pool from "../config/db.js";

export const distributePayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, date, loan_id, savings, other, loan_repayment, notes } =
      req.body;
    await client.query("BEGIN");

    const cashAccountId = await getDefaultCashAccount(client);

    // Savings deposits
    if (savings && typeof savings === "object") {
      for (const [productId, amount] of Object.entries(savings)) {
        if (amount && parseFloat(amount) > 0) {
          await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id)
             VALUES ($1, $2, 'savings', $3, $4, $5)`,
            [member_id, amount, date, notes || null, productId],
          );

          const product = await client.query(
            "SELECT linked_account_id, name FROM products WHERE id = $1",
            [productId],
          );
          const accountId = product.rows[0].linked_account_id;
          if (accountId) {
            await postJournal(client, {
              entry_date: date,
              description: `${product.rows[0].name} deposit — member ${member_id}`,
              source: "contribution",
              source_id: member_id,
              lines: [
                { account_id: cashAccountId, debit: amount, credit: 0 },
                { account_id: accountId, debit: 0, credit: amount },
              ],
            });
          }
        }
      }
    }

    // "Other" — fees, dues, fines
    if (other && typeof other === "object") {
      for (const [productId, amount] of Object.entries(other)) {
        if (amount && parseFloat(amount) > 0) {
          await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id)
             VALUES ($1, $2, 'other', $3, $4, $5)`,
            [member_id, amount, date, notes || null, productId],
          );

          const product = await client.query(
            "SELECT linked_account_id, name FROM products WHERE id = $1",
            [productId],
          );
          const accountId = product.rows[0].linked_account_id;
          if (accountId) {
            await postJournal(client, {
              entry_date: date,
              description: `${product.rows[0].name} — member ${member_id}`,
              source: "contribution",
              source_id: member_id,
              lines: [
                { account_id: cashAccountId, debit: amount, credit: 0 },
                { account_id: accountId, debit: 0, credit: amount },
              ],
            });
          }
        }
      }
    }

    // Loan repayment
    if (loan_repayment && parseFloat(loan_repayment) > 0) {
      if (!loan_id)
        throw new Error(
          "Loan selected required when entering a loan repayment amount",
        );

      await client.query(
        `INSERT INTO loan_repayments (loan_id, amount, repayment_date) VALUES ($1, $2, $3)`,
        [loan_id, loan_repayment, date],
      );

      const loanRow = await client.query(
        `SELECT l.principal, l.product_id, COALESCE(SUM(r.amount), 0) AS total_repaid
         FROM loans l LEFT JOIN loan_repayments r ON r.loan_id = l.id
         WHERE l.id = $1 GROUP BY l.principal, l.product_id`,
        [loan_id],
      );
      const { principal, total_repaid, product_id } = loanRow.rows[0];
      if (parseFloat(total_repaid) >= parseFloat(principal)) {
        await client.query(`UPDATE loans SET status = 'paid' WHERE id = $1`, [
          loan_id,
        ]);
      }

      const product = await client.query(
        "SELECT linked_account_id FROM products WHERE id = $1",
        [product_id],
      );
      const loanAccountId = product.rows[0]?.linked_account_id;
      if (loanAccountId) {
        await postJournal(client, {
          entry_date: date,
          description: `Loan repayment — loan #${loan_id}`,
          source: "repayment",
          source_id: loan_id,
          lines: [
            { account_id: cashAccountId, debit: loan_repayment, credit: 0 },
            { account_id: loanAccountId, debit: 0, credit: loan_repayment },
          ],
        });
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Payment distributed successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message || "Server error" });
  } finally {
    client.release();
  }
};
export const withdrawFunds = async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, product_id, amount, date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Enter a valid withdrawal amount" });
    }

    await client.query("BEGIN");

    // Check current balance for this member+product so we never let them withdraw more than they have
    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'savings' THEN amount 
                                 WHEN type = 'withdrawal' THEN -amount ELSE 0 END), 0) AS balance
       FROM contributions WHERE member_id = $1 AND product_id = $2`,
      [member_id, product_id],
    );
    const currentBalance = parseFloat(balanceResult.rows[0].balance);

    if (parseFloat(amount) > currentBalance) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient balance. Available: ₦${currentBalance.toLocaleString()}`,
      });
    }

    await client.query(
      `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id)
       VALUES ($1, $2, 'withdrawal', $3, $4, $5)`,
      [member_id, amount, date, notes || null, product_id],
    );

    const product = await client.query(
      "SELECT linked_account_id, name FROM products WHERE id = $1",
      [product_id],
    );
    const accountId = product.rows[0]?.linked_account_id;
    const cashAccountId = await getDefaultCashAccount(client);

    if (accountId) {
      await postJournal(client, {
        entry_date: date,
        description: `${product.rows[0].name} withdrawal — member ${member_id}`,
        source: "withdrawal",
        source_id: member_id,
        lines: [
          { account_id: accountId, debit: amount, credit: 0 },
          { account_id: cashAccountId, debit: 0, credit: amount },
        ],
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Withdrawal recorded successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message || "Server error" });
  } finally {
    client.release();
  }
};
export const correctContribution = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params; // the contribution's own id — familiar, visible in the ledger
    await client.query("BEGIN");

    const contribution = await client.query(
      "SELECT * FROM contributions WHERE id = $1",
      [id],
    );
    if (contribution.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Find and reverse the matching journal entry, if one exists
    const journalEntry = await client.query(
      `SELECT id FROM journal_entries WHERE source = 'contribution' AND source_id = $1`,
      [id],
    );
    if (journalEntry.rows.length > 0) {
      const entryId = journalEntry.rows[0].id;
      const lines = await client.query(
        "SELECT * FROM journal_lines WHERE journal_entry_id = $1",
        [entryId],
      );

      const reversalResult = await client.query(
        `INSERT INTO journal_entries (entry_date, description, source, source_id)
         VALUES (CURRENT_DATE, $1, 'reversal', $2) RETURNING id`,
        [`Correction — reversing contribution #${id}`, entryId],
      );
      const reversalId = reversalResult.rows[0].id;

      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
          [reversalId, line.account_id, line.credit, line.debit], // swapped to cancel out
        );
      }
    }

    // Remove the original contribution record itself
    await client.query("DELETE FROM contributions WHERE id = $1", [id]);

    await client.query("COMMIT");
    res.json({
      message: "Transaction corrected — you can now re-enter it correctly.",
      original: contribution.rows[0], // send back the details so the frontend can pre-fill a new form
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
