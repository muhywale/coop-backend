import pool from "..config/db.js";

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

    const otherResult = await pool.query(
      `SELECT m.id AS member_id, m.full_name, p.id AS product_id, p.name AS product_name, p.category,
              COALESCE(SUM(c.amount), 0) AS balance
       FROM members m
       CROSS JOIN products p
       LEFT JOIN contributions c ON c.member_id = m.id AND c.product_id = p.id
       WHERE p.category = 'other'
       GROUP BY m.id, m.full_name, p.id, p.name, p.category`,
    );

    res.json([...savingsResult.rows, ...loansResult.rows, ...otherResult.rows]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
