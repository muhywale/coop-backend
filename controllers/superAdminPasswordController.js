import bcrypt from "bcrypt";
import pool from "../config/db.js";
import {
  validateNewPassword,
  generateTempPassword,
} from "./passwordController.js";

// GET /api/super-admin/admins
// Every cooperative admin, with any open "forgot password" request first
export const listCooperativeAdmins = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.must_change_password,
              c.id AS cooperative_id, c.name AS cooperative_name,
              m.full_name, m.member_number,
              req.note AS request_note, req.created_at AS requested_at
       FROM users u
       JOIN cooperatives c ON c.id = u.cooperative_id
       LEFT JOIN members m ON m.id = u.member_id
       LEFT JOIN LATERAL (
         SELECT r.note, r.created_at
         FROM password_reset_requests r
         WHERE r.user_id = u.id AND r.status = 'pending'
         ORDER BY r.created_at DESC
         LIMIT 1
       ) req ON true
       WHERE u.role = 'admin'
       ORDER BY (req.created_at IS NULL), req.created_at, c.name, m.full_name, u.username`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error("listCooperativeAdmins failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/super-admin/reset-requests/count
// Pending requests from admins in OTHER cooperatives (your own cooperative's show on the Users page)
export const countPlatformResetRequests = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM password_reset_requests r
       JOIN users u ON u.id = r.user_id
       WHERE r.status = 'pending' AND u.role = 'admin' AND r.cooperative_id <> $1`,
      [req.user.cooperativeId],
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("countPlatformResetRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/super-admin/users/:userId/reset-password   body: { temp_password? }
export const resetCooperativeAdminPassword = async (req, res) => {
  try {
    const target = await pool.query(
      `SELECT u.id, u.username, u.role, c.name AS cooperative_name
       FROM users u JOIN cooperatives c ON c.id = u.cooperative_id
       WHERE u.id = $1`,
      [req.params.userId],
    );
    if (target.rows.length === 0)
      return res.status(404).json({ error: "User not found" });
    const user = target.rows[0];

    // Least privilege: this route only ever resets cooperative admins
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({
          error: "Only cooperative admin accounts can be reset from here",
        });
    }

    const supplied = String(req.body?.temp_password || "").trim();
    if (supplied) {
      const problem = validateNewPassword(supplied, user.username);
      if (problem) return res.status(400).json({ error: problem });
    }
    const tempPassword = supplied || generateTempPassword();

    const hash = await bcrypt.hash(tempPassword, 10);
    const now = new Date();
    // password_changed_at also signs them out of every device
    await pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = true, password_changed_at = $2 WHERE id = $3",
      [hash, now, user.id],
    );
    await pool.query(
      `UPDATE password_reset_requests SET status = 'done', resolved_at = $1, resolved_by = $2
       WHERE user_id = $3 AND status = 'pending'`,
      [now, req.user.userId, user.id],
    );

    console.log(
      `[password] platform admin ${req.user.userId} reset admin ${user.id} (${user.cooperative_name})`,
    );
    res.json({
      message: `Password reset for ${user.username} (${user.cooperative_name}). They are signed out everywhere and must change it at next login.`,
      username: user.username,
      temp_password: tempPassword,
    });
  } catch (err) {
    console.error("resetCooperativeAdminPassword failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// POST /api/super-admin/users/:userId/dismiss-request
export const dismissAdminRequest = async (req, res) => {
  try {
    const admin = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'admin'",
      [req.params.userId],
    );
    if (admin.rows.length === 0)
      return res.status(404).json({ error: "Admin not found" });

    await pool.query(
      `UPDATE password_reset_requests SET status = 'dismissed', resolved_at = $1, resolved_by = $2
       WHERE user_id = $3 AND status = 'pending'`,
      [new Date(), req.user.userId, req.params.userId],
    );
    res.json({ message: "Request dismissed" });
  } catch (err) {
    console.error("dismissAdminRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
