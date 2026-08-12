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
