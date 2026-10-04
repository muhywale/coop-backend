import pool from "../config/db.js";

export const getChartOfAccounts = async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === "true";
    const result = await pool.query(
      `SELECT * FROM chart_of_accounts WHERE cooperative_id = $1 ${includeInactive ? "" : "AND active = true"} ORDER BY code`,
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
    const result = await pool.query(
      `UPDATE chart_of_accounts SET active = false WHERE id = $1 AND cooperative_id = $2 RETURNING id`,
      [id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Account not found" });
    res.json({ message: "Account deactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const reactivateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE chart_of_accounts SET active = true WHERE id = $1 AND cooperative_id = $2 RETURNING id`,
      [id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Account not found" });
    res.json({ message: "Account reactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// Hard delete — only allowed when nothing actually depends on this account
export const deleteAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;

    const account = await pool.query(
      "SELECT id FROM chart_of_accounts WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    if (account.rows.length === 0)
      return res.status(404).json({ error: "Account not found" });

    const [journalCount, productCount, settingsCount] = await Promise.all([
      pool.query(
        "SELECT COUNT(*)::int AS n FROM journal_lines WHERE account_id = $1 AND cooperative_id = $2",
        [id, coopId],
      ),
      pool.query(
        "SELECT COUNT(*)::int AS n FROM products WHERE linked_account_id = $1 AND cooperative_id = $2",
        [id, coopId],
      ),
      pool.query(
        "SELECT COUNT(*)::int AS n FROM settings WHERE default_cash_account_id = $1 AND cooperative_id = $2",
        [id, coopId],
      ),
    ]);

    const reasons = [];
    if (journalCount.rows[0].n > 0)
      reasons.push(`${journalCount.rows[0].n} journal entry line(s)`);
    if (productCount.rows[0].n > 0)
      reasons.push(`${productCount.rows[0].n} product(s) linked to it`);
    if (settingsCount.rows[0].n > 0)
      reasons.push("it is set as the default cash account");

    if (reasons.length > 0) {
      return res.status(409).json({
        error: `Cannot delete — this account is in use by ${reasons.join(", ")}. Deactivate it instead to hide it without losing history.`,
      });
    }

    await pool.query(
      "DELETE FROM chart_of_accounts WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    res.json({ message: "Account deleted" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
