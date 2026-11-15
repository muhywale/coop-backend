import pool from "../config/db.js";

const read = (body) => {
  const title = String(body?.title || "").trim();
  const text = String(body?.body || "").trim();
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(body?.expires_on || "")
    ? body.expires_on
    : null;
  if (!title || title.length > 120)
    return { error: "Give the notice a title of up to 120 characters" };
  if (!text || text.length > 2000)
    return { error: "Write the notice, up to 2,000 characters" };
  return { title, text, pinned: !!body.pinned, expires };
};

// Admin: every notice, including expired ones
export const listNotices = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, body, pinned, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, created_at,
              (expires_on IS NOT NULL AND expires_on < CURRENT_DATE) AS expired
       FROM notices WHERE cooperative_id = $1
       ORDER BY pinned DESC, created_at DESC`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("listNotices failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const createNotice = async (req, res) => {
  try {
    const n = read(req.body);
    if (n.error) return res.status(400).json({ error: n.error });
    const result = await pool.query(
      `INSERT INTO notices (cooperative_id, title, body, pinned, expires_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        req.user.cooperativeId,
        n.title,
        n.text,
        n.pinned,
        n.expires,
        req.user.userId,
      ],
    );
    res.status(201).json({ id: result.rows[0].id, message: "Notice posted" });
  } catch (err) {
    console.error("createNotice failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const updateNotice = async (req, res) => {
  try {
    const n = read(req.body);
    if (n.error) return res.status(400).json({ error: n.error });
    const result = await pool.query(
      `UPDATE notices SET title = $1, body = $2, pinned = $3, expires_on = $4
       WHERE id = $5 AND cooperative_id = $6 RETURNING id`,
      [
        n.title,
        n.text,
        n.pinned,
        n.expires,
        req.params.id,
        req.user.cooperativeId,
      ],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Notice not found" });
    res.json({ message: "Notice updated" });
  } catch (err) {
    console.error("updateNotice failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const deleteNotice = async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM notices WHERE id = $1 AND cooperative_id = $2 RETURNING id",
      [req.params.id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Notice not found" });
    res.json({ message: "Notice deleted" });
  } catch (err) {
    console.error("deleteNotice failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Member: current notices only (not expired), pinned first
export const getMemberNotices = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, body, pinned, created_at,
              (created_at > NOW() - INTERVAL '7 days') AS is_new
       FROM notices
       WHERE cooperative_id = $1 AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
       ORDER BY pinned DESC, created_at DESC
       LIMIT 20`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("getMemberNotices failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
