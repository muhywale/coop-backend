import pool from "../config/db.js";

// GET all contributions
export const getContributions = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, m.full_name 
       FROM contributions c 
       JOIN members m ON c.member_id = m.id 
       ORDER BY c.contribution_date DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// GET contributions for a specific member
export const getContributionsByMember = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query(
      "SELECT * FROM contributions WHERE member_id = $1 ORDER BY contribution_date DESC",
      [memberId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST create new contribution
export const createContribution = async (req, res) => {
  try {
    const { member_id, amount, type, notes, product_id } = req.body;
    const result = await pool.query(
      `INSERT INTO contributions (member_id, amount, type, notes, product_id) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [member_id, amount, type, notes, product_id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE contribution
export const deleteContribution = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM contributions WHERE id = $1", [id]);
    res.json({ message: "Contribution deleted" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getMemberBalance = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type = 'savings' THEN amount 
                            WHEN type = 'withdrawal' THEN -amount 
                            ELSE 0 END), 0) AS balance
       FROM contributions
       WHERE member_id = $1`,
      [memberId],
    );
    res.json({ balance: result.rows[0].balance });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
