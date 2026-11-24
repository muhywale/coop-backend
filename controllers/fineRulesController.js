import pool from "../config/db.js";

const PERIODS = ["month", "week"];
const GROUPS = ["no_loan", "on_loan"];
const WHEN = ["nothing_paid", "any_shortfall"];
const BASES = ["all", "savings", "loan"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = {
  month: "monthly",
  week: "weekly",
  no_loan: "members not on a loan",
  on_loan: "members on a loan",
};

const blank = () => ({
  enabled: false,
  fixed_amount: "",
  fixed_when: "nothing_paid",
  percent: "",
  base: "all",
});

export const getFineRules = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const [settings, rules, products] = await Promise.all([
      pool.query(
        "SELECT fine_product_id, to_char(fines_start, 'YYYY-MM-DD') AS fines_start FROM cooperative_rules WHERE cooperative_id = $1",
        [coopId],
      ),
      pool.query(
        `SELECT period_type, member_group, enabled, fixed_amount, fixed_when, percent, base
         FROM fine_rules WHERE cooperative_id = $1`,
        [coopId],
      ),
      pool.query(
        `SELECT id, name, (linked_account_id IS NOT NULL) AS linked
         FROM products WHERE cooperative_id = $1 AND active = true AND category <> 'loan' ORDER BY name`,
        [coopId],
      ),
    ]);

    const grid = {
      month: { no_loan: blank(), on_loan: blank() },
      week: { no_loan: blank(), on_loan: blank() },
    };
    rules.rows.forEach((r) => {
      grid[r.period_type][r.member_group] = {
        enabled: r.enabled,
        fixed_amount: parseFloat(r.fixed_amount) || "",
        fixed_when: r.fixed_when,
        percent: parseFloat(r.percent) || "",
        base: r.base,
      };
    });

    res.json({
      fine_product_id: settings.rows[0]?.fine_product_id || null,
      fines_start: settings.rows[0]?.fines_start || null,
      products: products.rows,
      rules: grid,
    });
  } catch (err) {
    console.error("getFineRules failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const saveFineRules = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const body = req.body || {};

    let start = null;
    if (body.fines_start) {
      if (!DATE_RE.test(body.fines_start))
        return res
          .status(400)
          .json({ error: "Choose the month fines start from" });
      start = `${body.fines_start.slice(0, 7)}-01`;
    }

    let productId = null;
    if (body.fine_product_id) {
      productId = Number(body.fine_product_id);
      const product = await client.query(
        `SELECT id FROM products
         WHERE id = $1 AND cooperative_id = $2 AND active = true AND category <> 'loan' AND linked_account_id IS NOT NULL`,
        [productId, coopId],
      );
      if (product.rows.length === 0) {
        return res.status(400).json({
          error:
            "That payment line isn't linked to a ledger account. Link it to your fines income account on the Products page first.",
        });
      }
    }

    const prepared = [];
    for (const period of PERIODS) {
      for (const group of GROUPS) {
        const r = body.rules?.[period]?.[group];
        if (!r) continue;
        const fixed =
          r.fixed_amount === "" || r.fixed_amount == null
            ? 0
            : parseFloat(r.fixed_amount);
        const percent =
          r.percent === "" || r.percent == null ? 0 : parseFloat(r.percent);
        if (
          !(fixed >= 0 && fixed <= 1000000000) ||
          !(percent >= 0 && percent <= 100)
        ) {
          return res
            .status(400)
            .json({
              error: `Check the amounts for ${LABEL[period]} fines, ${LABEL[group]}`,
            });
        }
        const enabled = !!r.enabled;
        if (enabled && fixed <= 0 && percent <= 0) {
          return res
            .status(400)
            .json({
              error: `Enter a fixed fine or a percentage for ${LABEL[period]} fines, ${LABEL[group]}`,
            });
        }
        prepared.push({
          period,
          group,
          enabled,
          fixed,
          percent,
          when: WHEN.includes(r.fixed_when) ? r.fixed_when : "nothing_paid",
          base: BASES.includes(r.base) ? r.base : "all",
        });
      }
    }

    if (prepared.some((p) => p.enabled)) {
      if (!productId)
        return res
          .status(400)
          .json({ error: "Choose the Fines payment line first" });
      if (!start)
        return res
          .status(400)
          .json({ error: "Choose the month fines start from" });
    }

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cooperative_rules (cooperative_id, fine_product_id, fines_start)
       VALUES ($1, $2, $3)
       ON CONFLICT (cooperative_id) DO UPDATE SET
         fine_product_id = EXCLUDED.fine_product_id, fines_start = EXCLUDED.fines_start`,
      [coopId, productId, start],
    );
    for (const p of prepared) {
      await client.query(
        `INSERT INTO fine_rules (cooperative_id, period_type, member_group, enabled, fixed_amount, fixed_when, percent, base)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (cooperative_id, period_type, member_group) DO UPDATE SET
           enabled = EXCLUDED.enabled, fixed_amount = EXCLUDED.fixed_amount, fixed_when = EXCLUDED.fixed_when,
           percent = EXCLUDED.percent, base = EXCLUDED.base`,
        [
          coopId,
          p.period,
          p.group,
          p.enabled,
          p.fixed,
          p.when,
          p.percent,
          p.base,
        ],
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Saved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveFineRules failed:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
};
