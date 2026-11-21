import pool from "../config/db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;

export const listActivity = async (req, res) => {
  try {
    const showAll = req.user.role === "super_admin" && req.query.all === "1";
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [];

    if (!showAll)
      where.push(`a.cooperative_id = ${push(req.user.cooperativeId)}`);

    const username = String(req.query.username || "").trim();
    if (username) where.push(`LOWER(a.username) = LOWER(${push(username)})`);

    if (/^\d+$/.test(req.query.before_id || ""))
      where.push(`a.id < ${push(Number(req.query.before_id))}`);

    const q = String(req.query.q || "")
      .trim()
      .slice(0, 60)
      .replace(/[\\%_]/g, "\\$&");
    if (q) {
      const like = push(`%${q}%`);
      where.push(
        `(a.summary ILIKE ${like} OR a.username ILIKE ${like} OR m.full_name ILIKE ${like})`,
      );
    }

    // Day boundaries follow the viewer's own timezone
    const tz = TZ_RE.test(req.query.tz || "") ? req.query.tz : "Africa/Lagos";
    if (DATE_RE.test(req.query.from || "")) {
      where.push(
        `(a.created_at AT TIME ZONE ${push(tz)}::text)::date >= ${push(req.query.from)}::date`,
      );
    }
    if (DATE_RE.test(req.query.to || "")) {
      where.push(
        `(a.created_at AT TIME ZONE ${push(tz)}::text)::date <= ${push(req.query.to)}::date`,
      );
    }

    const limit = req.query.export === "1" ? 5000 : 50;

    const result = await pool.query(
      `SELECT a.id, a.created_at, a.username, a.role, a.action, a.summary, a.details, a.ip,
              c.name AS cooperative_name, m.full_name AS member_name, m.member_number, p.name AS product_name
       FROM activity_log a
       LEFT JOIN cooperatives c ON c.id = a.cooperative_id
       LEFT JOIN members m ON m.cooperative_id = a.cooperative_id
            AND m.id = CASE WHEN a.details->>'member_id' ~ '^[0-9]{1,9}$' THEN (a.details->>'member_id')::int END
       LEFT JOIN products p ON p.cooperative_id = a.cooperative_id
            AND p.id = CASE WHEN a.details->>'product_id' ~ '^[0-9]{1,9}$' THEN (a.details->>'product_id')::int END
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.id DESC
       LIMIT ${limit + 1}`,
      params,
    );

    res.json({
      rows: result.rows.slice(0, limit),
      has_more: result.rows.length > limit,
    });
  } catch (err) {
    console.error("listActivity failed:", err);
    if (err.code === "22023")
      return res.status(400).json({ error: "Unknown timezone" });
    res.status(500).json({ error: "Server error" });
  }
};

// For the "who" filter: everyone who appears in this cooperative's log
export const listActivityUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, COUNT(*)::int AS n FROM activity_log
       WHERE cooperative_id = $1 GROUP BY username ORDER BY username`,
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("listActivityUsers failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
