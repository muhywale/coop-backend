import pool from "../config/db.js";

export const getMyCooperative = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, logo_url, primary_color FROM cooperatives WHERE id = $1",
      [req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Cooperative not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const updateMyCooperative = async (req, res) => {
  try {
    const { name, logo_url, primary_color } = req.body;
    const result = await pool.query(
      "UPDATE cooperatives SET name = $1, logo_url = $2, primary_color = $3 WHERE id = $4 RETURNING id, name, logo_url, primary_color",
      [
        name,
        logo_url || null,
        primary_color || "#2f7ed8",
        req.user.cooperativeId,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
