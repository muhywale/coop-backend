import pool from "../config/db.js";

const FIELDS =
  "id, name, logo_url, primary_color, contact_phone, contact_whatsapp, payment_note, repayment_rounding";
const ROUNDING_STEPS = [1, 10, 50, 100, 500, 1000];

export const getMyCooperative = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${FIELDS} FROM cooperatives WHERE id = $1`,
      [req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Cooperative not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("getMyCooperative failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const updateMyCooperative = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name || name.length > 120)
      return res.status(400).json({ error: "Enter the cooperative's name" });

    const logo = String(req.body.logo_url || "").trim();
    if (logo && !/^https?:\/\//i.test(logo)) {
      return res
        .status(400)
        .json({
          error: "The logo address must start with http:// or https://",
        });
    }
    const colour = /^#[0-9a-fA-F]{6}$/.test(req.body.primary_color || "")
      ? req.body.primary_color
      : "#2f7ed8";
    const phone =
      String(req.body.contact_phone || "")
        .trim()
        .slice(0, 30) || null;
    const whatsapp =
      String(req.body.contact_whatsapp || "")
        .trim()
        .slice(0, 30) || null;
    const note =
      String(req.body.payment_note || "")
        .trim()
        .slice(0, 200) || null;
    const rounding = ROUNDING_STEPS.includes(
      Number(req.body.repayment_rounding),
    )
      ? Number(req.body.repayment_rounding)
      : 1;

    const result = await pool.query(
      `UPDATE cooperatives
       SET name = $1, logo_url = $2, primary_color = $3, contact_phone = $4, contact_whatsapp = $5,
           payment_note = $6, repayment_rounding = $7
       WHERE id = $8 RETURNING ${FIELDS}`,
      [
        name,
        logo || null,
        colour,
        phone,
        whatsapp,
        note,
        rounding,
        req.user.cooperativeId,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("updateMyCooperative failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
