import pool from "../config/db.js";

export const distributePayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      member_id,
      date,
      loan_id,
      savings, // now an object: { [product_id]: amount, ... }
      loan_repayment,
      card,
      reg_fee,
      notes,
    } = req.body;

    await client.query("BEGIN");

    // Insert one contribution row per savings product that has a non-zero amount
    if (savings && typeof savings === "object") {
      for (const [productId, amount] of Object.entries(savings)) {
        if (amount && parseFloat(amount) > 0) {
          await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id)
             VALUES ($1, $2, 'savings', $3, $4, $5)`,
            [member_id, amount, date, notes || null, productId],
          );
        }
      }
    }

    // Card and registration fee stay as fixed, non-product categories
    if (card && parseFloat(card) > 0) {
      await client.query(
        `INSERT INTO contributions (member_id, amount, type, contribution_date, notes)
         VALUES ($1, $2, 'card', $3, $4)`,
        [member_id, card, date, notes || null],
      );
    }
    if (reg_fee && parseFloat(reg_fee) > 0) {
      await client.query(
        `INSERT INTO contributions (member_id, amount, type, contribution_date, notes)
         VALUES ($1, $2, 'registration', $3, $4)`,
        [member_id, reg_fee, date, notes || null],
      );
    }

    // Loan repayment — unchanged, still tied to a specific existing loan
    if (loan_repayment && parseFloat(loan_repayment) > 0) {
      if (!loan_id) {
        throw new Error(
          "Loan selected required when entering a loan repayment amount",
        );
      }
      await client.query(
        `INSERT INTO loan_repayments (loan_id, amount, repayment_date) VALUES ($1, $2, $3)`,
        [loan_id, loan_repayment, date],
      );

      const totals = await client.query(
        `SELECT l.principal, COALESCE(SUM(r.amount), 0) AS total_repaid
         FROM loans l LEFT JOIN loan_repayments r ON r.loan_id = l.id
         WHERE l.id = $1 GROUP BY l.principal`,
        [loan_id],
      );
      const { principal, total_repaid } = totals.rows[0];
      if (parseFloat(total_repaid) >= parseFloat(principal)) {
        await client.query(`UPDATE loans SET status = 'paid' WHERE id = $1`, [
          loan_id,
        ]);
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
