import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

export const createMemberLogin = async (req, res) => {
  try {
    const { member_id, username, temp_password } = req.body;
    const cooperativeId = req.user.cooperativeId; // the admin creating this login belongs to a cooperative

    const member = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND cooperative_id = $2",
      [member_id, cooperativeId],
    );
    if (member.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const existingUser = await pool.query(
      "SELECT * FROM users WHERE member_id = $1",
      [member_id],
    );
    if (existingUser.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "This member already has a login." });
    }

    const usernameTaken = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username],
    );
    if (usernameTaken.rows.length > 0) {
      return res.status(409).json({ error: "Username already taken." });
    }

    const password_hash = await bcrypt.hash(temp_password, 10);

    const result = await pool.query(
      `INSERT INTO users (member_id, username, password_hash, must_change_password, cooperative_id)
       VALUES ($1, $2, $3, true, $4) RETURNING id, member_id, username, role, cooperative_id`,
      [member_id, username, password_hash, cooperativeId],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const changePassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { new_password } = req.body;
    const password_hash = await bcrypt.hash(new_password, 10);

    await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`,
      [password_hash, userId],
    );
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        memberId: user.member_id,
        role: user.role,
        cooperativeId: user.cooperative_id,
      },
      // eslint-disable-next-line no-undef
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.cookie("token", token, {
      httpOnly: true,
      // eslint-disable-next-line no-undef
      secure: process.env.NODE_ENV === "production", // HTTPS only in production
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        member_id: user.member_id,
        cooperative_id: user.cooperative_id,
        must_change_password: user.must_change_password,
      },
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
