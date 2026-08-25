import pool from "../config/db.js";

export const getChartOfAccounts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM chart_of_accounts WHERE cooperative_id = $1 ORDER BY code",
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const createAccount = async (req, res) => {
  try {
    const { code, name, account_type, normal_balance } = req.body;
    const result = await pool.query(
      `INSERT INTO chart_of_accounts (code, name, account_type, normal_balance, cooperative_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [code, name, account_type, normal_balance, req.user.cooperativeId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: `Account code "${req.body.code}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
};

export const updateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, account_type, normal_balance, active } = req.body;
    const result = await pool.query(
      `UPDATE chart_of_accounts SET code=$1, name=$2, account_type=$3, normal_balance=$4, active=$5
       WHERE id=$6 AND cooperative_id=$7 RETURNING *`,
      [
        code,
        name,
        account_type,
        normal_balance,
        active,
        id,
        req.user.cooperativeId,
      ],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Account not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const deactivateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE chart_of_accounts SET active = false WHERE id = $1 AND cooperative_id = $2`,
      [id, req.user.cooperativeId],
    );
    res.json({ message: "Account deactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
