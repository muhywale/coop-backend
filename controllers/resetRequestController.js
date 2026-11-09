import pool from "../config/db.js";

// The same answer whether or not the username exists
const GENERIC =
  "If that username exists, your admin has been notified and will contact you to reset your password.";

// POST /api/password/forgot   (public)   body: { username, note }
export const requestPasswordReset = async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const note =
      String(req.body?.note || "")
        .trim()
        .slice(0, 200) || null;

    if (username.length >= 3 && username.length <= 50) {
      const found = await pool.query(
        "SELECT id, cooperative_id, role FROM users WHERE LOWER(username) = LOWER($1)",
        [username],
      );
      const user = found.rows[0];

      // Platform (super admin) accounts are never reset through this route
      if (user && user.role !== "super_admin") {
        await pool.query(
          `INSERT INTO password_reset_requests (user_id, cooperative_id, note)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) WHERE status = 'pending'
           DO UPDATE SET created_at = NOW(),
                         note = COALESCE(EXCLUDED.note, password_reset_requests.note)`,
          [user.id, user.cooperative_id, note],
        );
        console.log(`[password] reset requested for user ${user.id}`);
      }
    }

    res.json({ message: GENERIC });
  } catch (err) {
    console.error("requestPasswordReset failed:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

// GET /api/password/requests   (admin)
export const listResetRequests = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.user_id, r.note, r.created_at,
              u.username, u.role, m.full_name, m.member_number
       FROM password_reset_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN members m ON m.id = u.member_id
       WHERE r.cooperative_id = $1 AND r.status = 'pending'
       ORDER BY r.created_at`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("listResetRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/password/requests/count   (admin, used by the sidebar badge)
export const countResetRequests = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM password_reset_requests WHERE cooperative_id = $1 AND status = 'pending'",
      [req.user.cooperativeId],
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("countResetRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// POST /api/password/requests/:id/dismiss   (admin)
export const dismissResetRequest = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE password_reset_requests
       SET status = 'dismissed', resolved_at = $1, resolved_by = $2
       WHERE id = $3 AND cooperative_id = $4 AND status = 'pending'
       RETURNING id`,
      [new Date(), req.user.userId, req.params.id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Request not found" });
    res.json({ message: "Request dismissed" });
  } catch (err) {
    console.error("dismissResetRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
