import pool from "../config/db.js";

const DEDUCT_MODES = ["none", "same", "all"];

const savingsProducts = (db, coopId) =>
  db.query(
    "SELECT id, name FROM products WHERE cooperative_id = $1 AND category = 'savings' AND active = true ORDER BY name",
    [coopId],
  );

export const getRequestRules = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const [coopRules, savings, loanProducts, loanRules] = await Promise.all([
      pool.query(
        "SELECT withdrawable_product_ids FROM cooperative_rules WHERE cooperative_id = $1",
        [coopId],
      ),
      savingsProducts(pool, coopId),
      pool.query(
        "SELECT id, name FROM products WHERE cooperative_id = $1 AND category = 'loan' AND active = true ORDER BY name",
        [coopId],
      ),
      pool.query(
        "SELECT loan_product_id, multiple, savings_product_ids, deduct_mode FROM loan_borrowing_rules WHERE cooperative_id = $1",
        [coopId],
      ),
    ]);

    const ruleMap = {};
    loanRules.rows.forEach((r) => {
      ruleMap[r.loan_product_id] = {
        multiple: parseFloat(r.multiple),
        savings_product_ids: r.savings_product_ids || [],
        deduct_mode: r.deduct_mode,
      };
    });

    res.json({
      withdrawable_product_ids:
        coopRules.rows[0]?.withdrawable_product_ids || [],
      savings_products: savings.rows,
      loan_products: loanProducts.rows.map((p) => ({
        id: p.id,
        name: p.name,
        rule: ruleMap[p.id] || null,
      })),
    });
  } catch (err) {
    console.error("getRequestRules failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Only the parts sent are changed, so each section of the page can save on its own
export const saveRequestRules = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const body = req.body || {};
    const idList = (value) => [
      ...new Set(
        (Array.isArray(value) ? value : [])
          .map(Number)
          .filter(Number.isInteger),
      ),
    ];

    const savings = await savingsProducts(client, coopId);
    const validSavings = new Set(savings.rows.map((p) => p.id));

    await client.query("BEGIN");
    const fail = async (error) => {
      await client.query("ROLLBACK");
      return res.status(400).json({ error });
    };

    if (body.withdrawable_product_ids !== undefined) {
      const ids = idList(body.withdrawable_product_ids);
      if (ids.some((id) => !validSavings.has(id)))
        return fail(
          "One of the accounts isn't a savings account of this cooperative",
        );
      await client.query(
        `INSERT INTO cooperative_rules (cooperative_id, withdrawable_product_ids)
         VALUES ($1, $2::int[])
         ON CONFLICT (cooperative_id) DO UPDATE SET withdrawable_product_ids = EXCLUDED.withdrawable_product_ids`,
        [coopId, ids],
      );
    }

    if (body.loan_rules !== undefined) {
      const loans = await client.query(
        "SELECT id FROM products WHERE cooperative_id = $1 AND category = 'loan'",
        [coopId],
      );
      const validLoans = new Set(loans.rows.map((p) => p.id));

      for (const rule of Array.isArray(body.loan_rules)
        ? body.loan_rules
        : []) {
        const loanId = Number(rule.loan_product_id);
        if (!validLoans.has(loanId))
          return fail("That isn't a loan type of this cooperative");

        // A blank multiple means "no guide for this loan type"
        if (
          rule.multiple === "" ||
          rule.multiple === null ||
          rule.multiple === undefined
        ) {
          await client.query(
            "DELETE FROM loan_borrowing_rules WHERE loan_product_id = $1 AND cooperative_id = $2",
            [loanId, coopId],
          );
          continue;
        }

        const multiple = parseFloat(rule.multiple);
        if (!(multiple > 0 && multiple <= 100))
          return fail("The multiple must be between 0 and 100");
        const savingsIds = idList(rule.savings_product_ids);
        if (savingsIds.some((id) => !validSavings.has(id)))
          return fail(
            "One of the accounts isn't a savings account of this cooperative",
          );
        const mode = DEDUCT_MODES.includes(rule.deduct_mode)
          ? rule.deduct_mode
          : "same";

        await client.query(
          `INSERT INTO loan_borrowing_rules (cooperative_id, loan_product_id, multiple, savings_product_ids, deduct_mode)
           VALUES ($1, $2, $3, $4::int[], $5)
           ON CONFLICT (loan_product_id) DO UPDATE SET
             multiple = EXCLUDED.multiple,
             savings_product_ids = EXCLUDED.savings_product_ids,
             deduct_mode = EXCLUDED.deduct_mode`,
          [coopId, loanId, multiple, savingsIds, mode],
        );
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Saved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveRequestRules failed:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
};
