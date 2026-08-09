import pool from "../config/db.js";

// GET all loans
export const getLoans = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, m.full_name,
              l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN members m ON l.member_id = m.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       GROUP BY l.id, m.full_name
       ORDER BY l.date_issued DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// GET loans for a specific member
export const getLoansByMember = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query(
      `SELECT l.*, l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1
       GROUP BY l.id
       ORDER BY l.date_issued DESC`,
      [memberId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST create new loan
export const createLoan = async (req, res) => {
  try {
    const { member_id, principal, product_id } = req.body;

    const product = await pool.query("SELECT * FROM products WHERE id = $1", [
      product_id,
    ]);
    if (product.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    const { interest_rate } = product.rows[0];

    const result = await pool.query(
      `INSERT INTO loans (member_id, principal, interest_rate, product_id) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [member_id, principal, interest_rate, product_id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST record a repayment against a loan
export const recordRepayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { loanId } = req.params;
    const { amount } = req.body;

    await client.query("BEGIN");

    const repayment = await client.query(
      `INSERT INTO loan_repayments (loan_id, amount) VALUES ($1, $2) RETURNING *`,
      [loanId, amount],
    );

    const totals = await client.query(
      `SELECT l.principal, COALESCE(SUM(r.amount), 0) AS total_repaid
       FROM loans l
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.id = $1
       GROUP BY l.principal`,
      [loanId],
    );

    const { principal, total_repaid } = totals.rows[0];
    if (parseFloat(total_repaid) >= parseFloat(principal)) {
      await client.query(`UPDATE loans SET status = 'paid' WHERE id = $1`, [
        loanId,
      ]);
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

// GET repayment history for a loan
export const getRepayments = async (req, res) => {
  try {
    const { loanId } = req.params;
    const result = await pool.query(
      "SELECT * FROM loan_repayments WHERE loan_id = $1 ORDER BY repayment_date",
      [loanId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// Admin-only: get loans for a specific member (by ID in the URL)
export const getLoansByMemberId = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query(
      `SELECT l.*, p.name AS product_name,
              l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       LEFT JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1
       GROUP BY l.id, p.name
       ORDER BY l.date_issued DESC`,
      [memberId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
