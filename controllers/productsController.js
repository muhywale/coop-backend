import pool from "../config/db.js";

export const getProducts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE active = true AND cooperative_id = $1 ORDER BY category, name",
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const createProduct = async (req, res) => {
  try {
    const { name, category, description, linked_account_id } = req.body;
    const interest_type = req.body.interest_type || null;
    const interest_rate = req.body.interest_rate
      ? parseFloat(req.body.interest_rate)
      : null;

    const result = await pool.query(
      `INSERT INTO products (name, category, interest_type, interest_rate, description, linked_account_id, cooperative_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        name,
        category,
        interest_type,
        interest_rate,
        description,
        linked_account_id || null,
        req.user.cooperativeId,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      category,
      interest_type,
      interest_rate,
      description,
      linked_account_id,
    } = req.body;
    const result = await pool.query(
      `UPDATE products SET name=$1, category=$2, interest_type=$3, interest_rate=$4, description=$5, linked_account_id=$6
       WHERE id=$7 AND cooperative_id=$8 RETURNING *`,
      [
        name,
        category,
        interest_type,
        interest_rate,
        description,
        linked_account_id || null,
        id,
        req.user.cooperativeId,
      ],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Product not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE products SET active = false WHERE id = $1 AND cooperative_id = $2`,
      [id, req.user.cooperativeId],
    );
    res.json({ message: "Product deactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
