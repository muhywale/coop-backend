import bcrypt from "bcrypt";
import pool from "../config/db.js";

const DEFAULT_ACCOUNTS = [
  ["1000", "Cash/Bank", "asset", "debit"],
  ["1010", "Loan to Members", "asset", "debit"],
  ["3000", "Savings (Members)", "equity", "credit"],
  ["3001", "Shares (Members)", "equity", "credit"],
  ["4000", "Loan Interest Income", "income", "credit"],
  ["4001", "Entrance Fees", "income", "credit"],
  ["5000", "General Expenses", "expense", "debit"],
];

export const createCooperative = async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, admin_username, admin_password, admin_full_name } = req.body;

    if (!name || !admin_username || !admin_password || !admin_full_name) {
      return res.status(400).json({ error: "All fields are required" });
    }

    await client.query("BEGIN");

    // 1. Create the cooperative
    const coopResult = await client.query(
      `INSERT INTO cooperatives (name) VALUES ($1) RETURNING id`,
      [name],
    );
    const coopId = coopResult.rows[0].id;

    // 2. Seed default Chart of Accounts
    let cashAccountId = null;
    for (const [code, accName, type, normal] of DEFAULT_ACCOUNTS) {
      const acc = await client.query(
        `INSERT INTO chart_of_accounts (code, name, account_type, normal_balance, cooperative_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [code, accName, type, normal, coopId],
      );
      if (code === "1000") cashAccountId = acc.rows[0].id;
    }

    // 3. Create settings with default cash account
    await client.query(
      `INSERT INTO settings (default_cash_account_id, cooperative_id) VALUES ($1, $2)`,
      [cashAccountId, coopId],
    );

    // 4. Seed starter savings/loan products
    const regularSavings = await client.query(
      `INSERT INTO products (name, category, cooperative_id, linked_account_id)
       VALUES ('Regular Savings', 'savings', $1, (SELECT id FROM chart_of_accounts WHERE code = '3000' AND cooperative_id = $1)) RETURNING id`,
      [coopId],
    );
    await client.query(
      `INSERT INTO products (name, category, interest_type, interest_rate, cooperative_id, linked_account_id)
       VALUES ('Ordinary Loan', 'loan', 'reducing_balance', 5.00, $1, (SELECT id FROM chart_of_accounts WHERE code = '1010' AND cooperative_id = $1))`,
      [coopId],
    );

    // 5. Create the first member + admin login
    const member = await client.query(
      `INSERT INTO members (full_name, cooperative_id) VALUES ($1, $2) RETURNING id`,
      [admin_full_name, coopId],
    );

    const usernameTaken = await client.query(
      "SELECT id FROM users WHERE username = $1",
      [admin_username],
    );
    if (usernameTaken.rows.length > 0) {
      throw new Error("Username already taken");
    }

    const password_hash = await bcrypt.hash(admin_password, 10);
    await client.query(
      `INSERT INTO users (member_id, username, password_hash, role, cooperative_id, must_change_password)
       VALUES ($1, $2, $3, 'admin', $4, false)`,
      [member.rows[0].id, admin_username, password_hash, coopId],
    );

    await client.query("COMMIT");
    res
      .status(201)
      .json({
        message: `Cooperative "${name}" created successfully`,
        cooperative_id: coopId,
      });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const getCooperatives = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
              (SELECT COUNT(*) FROM members m WHERE m.cooperative_id = c.id) AS member_count
       FROM cooperatives c ORDER BY c.created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
