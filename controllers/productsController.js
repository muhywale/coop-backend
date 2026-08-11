import pool from "../config/db.js";

export const getProducts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE active = true ORDER BY category, name",
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const createProduct = async (req, res) => {
  try {
    const { name, category, description } = req.body;
    const interest_type = req.body.interest_type || null;
    const interest_rate = req.body.interest_rate
      ? parseFloat(req.body.interest_rate)
      : null;

    const result = await pool.query(
      `INSERT INTO products (name, category, interest_type, interest_rate, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, category, interest_type, interest_rate, description],
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
    const { name, category, interest_type, interest_rate, description } =
      req.body;
    const result = await pool.query(
      `UPDATE products SET name=$1, category=$2, interest_type=$3, interest_rate=$4, description=$5
       WHERE id=$6 RETURNING *`,
      [name, category, interest_type, interest_rate, description, id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE products SET active = false WHERE id = $1`, [id]);
    res.json({ message: "Product deactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
