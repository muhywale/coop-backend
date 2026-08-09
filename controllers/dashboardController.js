import pool from "../config/db.js";

export const getContributionsSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         m.id AS member_id, 
         m.full_name,
         COALESCE(SUM(CASE WHEN c.type = 'savings' THEN c.amount 
                            WHEN c.type = 'withdrawal' THEN -c.amount ELSE 0 END), 0) AS savings_balance,
         COALESCE(SUM(CASE WHEN c.type = 'registration' THEN c.amount ELSE 0 END), 0) AS registration_paid,
         COUNT(c.id) AS total_transactions
       FROM members m
       LEFT JOIN contributions c ON c.member_id = m.id
       GROUP BY m.id, m.full_name
       ORDER BY savings_balance DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getLoansSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         m.id AS member_id,
         m.full_name,
         COUNT(l.id) AS total_loans,
         COALESCE(SUM(l.principal), 0) AS total_borrowed,
         COALESCE(SUM(l.principal - COALESCE(r.total_repaid, 0)), 0) AS total_outstanding
       FROM members m
       LEFT JOIN loans l ON l.member_id = m.id
       LEFT JOIN (
         SELECT loan_id, SUM(amount) AS total_repaid
         FROM loan_repayments
         GROUP BY loan_id
       ) r ON r.loan_id = l.id
       GROUP BY m.id, m.full_name
       ORDER BY total_outstanding DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getBalancesByProduct = async (req, res) => {
  try {
    const savingsResult = await pool.query(
      `SELECT m.id AS member_id, m.full_name, p.id AS product_id, p.name AS product_name, p.category,
              COALESCE(SUM(CASE WHEN c.type = 'savings' THEN c.amount 
                                 WHEN c.type = 'withdrawal' THEN -c.amount ELSE 0 END), 0) AS balance
       FROM members m
       CROSS JOIN products p
       LEFT JOIN contributions c ON c.member_id = m.id AND c.product_id = p.id
       WHERE p.category = 'savings'
       GROUP BY m.id, m.full_name, p.id, p.name, p.category`,
    );

    const loansResult = await pool.query(
      `SELECT m.id AS member_id, m.full_name, p.id AS product_id, p.name AS product_name, p.category,
              COALESCE(SUM(l.principal - COALESCE(r.total_repaid, 0)), 0) AS balance
       FROM members m
       CROSS JOIN products p
       LEFT JOIN loans l ON l.member_id = m.id AND l.product_id = p.id
       LEFT JOIN (
         SELECT loan_id, SUM(amount) AS total_repaid FROM loan_repayments GROUP BY loan_id
       ) r ON r.loan_id = l.id
       WHERE p.category = 'loan'
       GROUP BY m.id, m.full_name, p.id, p.name, p.category`,
    );

    res.json([...savingsResult.rows, ...loansResult.rows]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getPaymentsLedger = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         c.id, c.contribution_date AS date, m.full_name, p.name AS product_name, 
         p.category, c.type, c.amount, 'contribution' AS source
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       LEFT JOIN products p ON c.product_id = p.id

       UNION ALL

       SELECT 
         r.id, r.repayment_date AS date, m.full_name, p.name AS product_name,
         'loan_repayment' AS category, 'loan_repayment' AS type, r.amount, 'repayment' AS source
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       JOIN members m ON l.member_id = m.id
       LEFT JOIN products p ON l.product_id = p.id

       ORDER BY date DESC, full_name`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
