import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../config/db.js";

const MIN_LENGTH = 8;
const COMMON = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "11111111",
  "qwertyui",
  "qwerty123",
  "admin123",
  "welcome1",
  "abc12345",
  "iloveyou1",
]);

// Returns an error message, or null when the password is acceptable
export const validateNewPassword = (password, username) => {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  if (password.length > 72) return "Password must be 72 characters or fewer";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    return "Use both letters and numbers";
  if (String(username || "").toLowerCase() === password.toLowerCase()) {
    return "Password can't be the same as the username";
  }
  if (COMMON.has(password.toLowerCase()))
    return "That password is too common. Choose another.";
  return null;
};

// Readable temporary password (no look-alike characters such as 0/O or 1/l)
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const generateTempPassword = () => {
  let password;
  do {
    password = Array.from(
      { length: 10 },
      () => ALPHABET[crypto.randomInt(ALPHABET.length)],
    ).join("");
  } while (validateNewPassword(password, ""));
  return password;
};

// POST /api/password/change   body: { current_password, new_password }
export const changeMyPassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const result = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE id = $1",
      [req.user.userId],
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Please log in again" });
    const user = result.rows[0];

    // 400, not 401, so the app doesn't mistake a typo for being logged out
    const correct = await bcrypt.compare(
      String(current_password || ""),
      user.password_hash,
    );
    if (!correct)
      return res
        .status(400)
        .json({ error: "Your current password is incorrect" });

    const problem = validateNewPassword(new_password, user.username);
    if (problem) return res.status(400).json({ error: problem });

    if (await bcrypt.compare(new_password, user.password_hash)) {
      return res.status(400).json({
        error: "The new password must be different from the current one",
      });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = $2 WHERE id = $3",
      [hash, new Date(), user.id],
    );

    console.log(`[password] user ${user.id} changed their own password`);
    res.json({
      message: "Password changed. Please log in again with your new password.",
    });
  } catch (err) {
    console.error("changeMyPassword failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
