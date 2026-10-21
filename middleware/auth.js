import jwt from "jsonwebtoken";
import pool from "../config/db.js";

export const verifyToken = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "No token provided" });

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    if (!decoded?.userId)
      return res.status(401).json({ error: "Please log in again" });

    try {
      // Re-check the account every time so removed or demoted users lose access immediately
      const result = await pool.query(
        "SELECT role, cooperative_id, member_id FROM users WHERE id = $1",
        [decoded.userId],
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "This account no longer exists" });
      }
      req.user = {
        ...decoded,
        role: result.rows[0].role,
        cooperativeId: result.rows[0].cooperative_id,
        memberId: result.rows[0].member_id,
      };
      next();
    } catch (e) {
      console.error("verifyToken failed:", e);
      res.status(500).json({ error: "Server error" });
    }
  });
};

export const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin" && req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

export const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
};
