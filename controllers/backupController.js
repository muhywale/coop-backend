import pool from "../config/db.js";

// Fixed list, so nothing user-supplied ever reaches the SQL
const COOP_TABLES = [
  "chart_of_accounts",
  "settings",
  "products",
  "members",
  "member_aliases",
  "contributions",
  "loans",
  "loan_repayments",
  "journal_entries",
  "journal_lines",
];

// Postgres builds the JSON itself, so dates stay "2026-10-14" and amounts stay exact
const exportTable = async (table, coopId, hideColumn) => {
  const expr = hideColumn ? `to_jsonb(t) - '${hideColumn}'` : "to_jsonb(t)";
  const where = coopId ? "WHERE t.cooperative_id = $1" : "";
  const result = await pool.query(
    `SELECT COALESCE(jsonb_agg(${expr} ORDER BY t.id), '[]'::jsonb) AS rows FROM ${table} t ${where}`,
    coopId ? [coopId] : [],
  );
  return result.rows[0].rows;
};

export const exportBackup = async (req, res) => {
  try {
    const wantsAll = req.query.scope === "all";
    if (wantsAll && req.user.role !== "super_admin") {
      return res
        .status(403)
        .json({
          error: "Only the platform admin can export every cooperative",
        });
    }
    const coopId = wantsAll ? null : req.user.cooperativeId;

    const tables = {};
    const warnings = [];

    const coops = await pool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) AS rows
       FROM cooperatives c ${coopId ? "WHERE c.id = $1" : ""}`,
      coopId ? [coopId] : [],
    );
    tables.cooperatives = coops.rows[0].rows;

    for (const table of COOP_TABLES) {
      try {
        tables[table] = await exportTable(table, coopId);
      } catch (err) {
        if (err.code === "42P01") {
          tables[table] = [];
          warnings.push(
            `Table "${table}" does not exist in this database, so it was skipped`,
          );
        } else {
          throw err;
        }
      }
    }
    // Logins without password hashes
    tables.users = await exportTable("users", coopId, "password_hash");

    const counts = {};
    Object.entries(tables).forEach(([name, rows]) => {
      counts[name] = rows.length;
    });

    console.log(
      `[backup] user ${req.user.userId} exported ${wantsAll ? "ALL cooperatives" : `cooperative ${coopId}`}`,
    );

    res.json({
      meta: {
        exported_at: new Date().toISOString(),
        scope: wantsAll ? "all" : "cooperative",
        cooperative_id: coopId,
        exported_by_user_id: req.user.userId,
        note: "Password hashes are not included. Users must have their passwords reset after a restore.",
      },
      counts,
      warnings,
      tables,
    });
  } catch (err) {
    console.error("exportBackup failed:", err);
    res.status(500).json({ error: "Backup failed" });
  }
};
