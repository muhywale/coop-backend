import bcrypt from "bcrypt";
import pool from "../config/db.js";
import {
  validateNewPassword,
  generateTempPassword,
} from "./passwordController.js";

const ROLES = ["member", "admin"];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;

// Returns the target user, or sends the error response and returns null
const loadTarget = async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, role FROM users WHERE id = $1 AND cooperative_id = $2",
    [req.params.id, req.user.cooperativeId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  const target = result.rows[0];
  if (target.role === "super_admin" && req.user.role !== "super_admin") {
    res.status(403).json({ error: "Platform accounts can't be changed here" });
    return null;
  }
  return target;
};

const isSelf = (req) => Number(req.params.id) === Number(req.user.userId);

// True when the cooperative would still have an admin after this user stops being one
const otherAdminExists = async (coopId, excludeId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE cooperative_id = $1 AND role IN ('admin', 'super_admin') AND id <> $2",
    [coopId, excludeId],
  );
  return result.rows[0].n > 0;
};

export const getUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.must_change_password, u.created_at,
              u.member_id, m.full_name, m.member_number
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       WHERE u.cooperative_id = $1
       ORDER BY u.role, m.full_name, u.username`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("getUsers failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const createUser = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const memberId = Number(req.body.member_id);
    const username = String(req.body.username || "").trim();
    const supplied = String(req.body.temp_password || "").trim();
    const role = req.body.role || "member";

    if (!memberId) return res.status(400).json({ error: "Select a member" });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error:
          "Username must be 3–30 characters: letters, numbers, dot, dash or underscore",
      });
    }
    if (!ROLES.includes(role))
      return res.status(400).json({ error: "Role must be member or admin" });

    // Blank means "generate one for me"
    if (supplied) {
      const problem = validateNewPassword(supplied, username);
      if (problem) return res.status(400).json({ error: problem });
    }
    const tempPassword = supplied || generateTempPassword();

    const member = await pool.query(
      "SELECT id FROM members WHERE id = $1 AND cooperative_id = $2",
      [memberId, coopId],
    );
    if (member.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });

    const existing = await pool.query(
      "SELECT id FROM users WHERE member_id = $1 AND cooperative_id = $2",
      [memberId, coopId],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "This member already has a login. Reset the password instead.",
      });
    }

    const taken = await pool.query(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1)",
      [username],
    );
    if (taken.rows.length > 0)
      return res.status(409).json({ error: "That username is already taken" });

    const hash = await bcrypt.hash(tempPassword, 10);
    const result = await pool.query(
      `INSERT INTO users (member_id, username, password_hash, role, cooperative_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id, username, role`,
      [memberId, username, hash, role, coopId],
    );
    res.status(201).json({ ...result.rows[0], temp_password: tempPassword });
  } catch (err) {
    console.error("createUser failed:", err);
    if (err.code === "23505")
      return res
        .status(409)
        .json({ error: "That username or member already has a login" });
    res.status(500).json({ error: "Server error" });
  }
};

export const updateUserRole = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const { role } = req.body;
    if (!ROLES.includes(role))
      return res.status(400).json({ error: "Role must be member or admin" });
    if (isSelf(req))
      return res.status(400).json({ error: "You can't change your own role" });

    const target = await loadTarget(req, res);
    if (!target) return;

    if (
      target.role !== "member" &&
      role === "member" &&
      !(await otherAdminExists(coopId, target.id))
    ) {
      return res
        .status(400)
        .json({ error: "The cooperative must keep at least one admin" });
    }

    await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 AND cooperative_id = $3",
      [role, target.id, coopId],
    );
    res.json({
      message: `${target.username} is now ${role === "admin" ? "an admin" : "a member"}`,
    });
  } catch (err) {
    console.error("updateUserRole failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const resetUserPassword = async (req, res) => {
  try {
    const supplied = String(req.body.temp_password || "").trim();
    if (isSelf(req))
      return res
        .status(400)
        .json({ error: "Use Change password for your own account" });

    const target = await loadTarget(req, res);
    if (!target) return;

    if (supplied) {
      const problem = validateNewPassword(supplied, target.username);
      if (problem) return res.status(400).json({ error: problem });
    }
    const tempPassword = supplied || generateTempPassword();

    const hash = await bcrypt.hash(tempPassword, 10);
    // password_changed_at also signs them out of every device
    await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = true, password_changed_at = $2
       WHERE id = $3 AND cooperative_id = $4`,
      [hash, new Date(), target.id, req.user.cooperativeId],
    );

    await pool.query(
      `UPDATE password_reset_requests SET status = 'done', resolved_at = $1, resolved_by = $2
       WHERE user_id = $3 AND status = 'pending'`,
      [new Date(), req.user.userId, target.id],
    );

    console.log(
      `[password] user ${req.user.userId} reset the password for user ${target.id}`,
    );
    res.json({
      message: `Password reset for ${target.username}. They are signed out everywhere and must change it at next login.`,
      temp_password: tempPassword,
    });
  } catch (err) {
    console.error("resetUserPassword failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    if (isSelf(req))
      return res
        .status(400)
        .json({ error: "You can't delete your own account" });

    const target = await loadTarget(req, res);
    if (!target) return;

    if (
      target.role !== "member" &&
      !(await otherAdminExists(coopId, target.id))
    ) {
      return res
        .status(400)
        .json({ error: "The cooperative must keep at least one admin" });
    }

    await pool.query(
      "DELETE FROM users WHERE id = $1 AND cooperative_id = $2",
      [target.id, coopId],
    );
    res.json({
      message: `Login for ${target.username} removed. The member record is untouched.`,
    });
  } catch (err) {
    console.error("deleteUser failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
