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
    const { name, category, interest_type, interest_rate, description } =
      req.body;
    const result = await pool.query(
      `INSERT INTO products (name, category, interest_type, interest_rate, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, category, interest_type, interest_rate, description],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
