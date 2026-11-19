import pool from "../config/db.js";

const loadRules = async (coopId) => {
  const result = await pool.query(
    "SELECT * FROM cooperative_rules WHERE cooperative_id = $1",
    [coopId],
  );
  const row = result.rows[0];
  return {
    borrow_multiple:
      row?.borrow_multiple != null ? parseFloat(row.borrow_multiple) : null,
    borrow_deduct_outstanding: row ? row.borrow_deduct_outstanding : true,
    borrow_product_ids: row?.borrow_product_ids || [],
    withdrawable_product_ids: row?.withdrawable_product_ids || [],
  };
};

const savingsProducts = (coopId) =>
  pool.query(
    "SELECT id, name FROM products WHERE cooperative_id = $1 AND category = 'savings' AND active = true ORDER BY name",
    [coopId],
  );

export const getRequestRules = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const [rules, products] = await Promise.all([
      loadRules(coopId),
      savingsProducts(coopId),
    ]);
    res.json({ ...rules, savings_products: products.rows });
  } catch (err) {
    console.error("getRequestRules failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Only the fields sent are changed, so each settings screen can save its own part
export const saveRequestRules = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const body = req.body || {};
    const [current, products] = await Promise.all([
      loadRules(coopId),
      savingsProducts(coopId),
    ]);
    const valid = new Set(products.rows.map((p) => p.id));

    const ids = (value, fallback) =>
      value === undefined
        ? fallback
        : [
            ...new Set(
              (Array.isArray(value) ? value : [])
                .map(Number)
                .filter(Number.isInteger),
            ),
          ];

    const withdrawable = ids(
      body.withdrawable_product_ids,
      current.withdrawable_product_ids,
    );
    const borrowIds = ids(body.borrow_product_ids, current.borrow_product_ids);
    if ([...withdrawable, ...borrowIds].some((id) => !valid.has(id))) {
      return res
        .status(400)
        .json({
          error:
            "One of the accounts isn't a savings account of this cooperative",
        });
    }

    let multiple = current.borrow_multiple;
    if (body.borrow_multiple !== undefined) {
      multiple =
        body.borrow_multiple === "" || body.borrow_multiple === null
          ? null
          : parseFloat(body.borrow_multiple);
      if (multiple !== null && !(multiple > 0 && multiple <= 100)) {
        return res
          .status(400)
          .json({ error: "The borrowing multiple must be between 0 and 100" });
      }
    }
    const deduct =
      body.borrow_deduct_outstanding === undefined
        ? current.borrow_deduct_outstanding
        : !!body.borrow_deduct_outstanding;

    await pool.query(
      `INSERT INTO cooperative_rules
         (cooperative_id, borrow_multiple, borrow_deduct_outstanding, borrow_product_ids, withdrawable_product_ids)
       VALUES ($1, $2, $3, $4::int[], $5::int[])
       ON CONFLICT (cooperative_id) DO UPDATE SET
         borrow_multiple = EXCLUDED.borrow_multiple,
         borrow_deduct_outstanding = EXCLUDED.borrow_deduct_outstanding,
         borrow_product_ids = EXCLUDED.borrow_product_ids,
         withdrawable_product_ids = EXCLUDED.withdrawable_product_ids`,
      [coopId, multiple, deduct, borrowIds, withdrawable],
    );
    res.json({ message: "Saved" });
  } catch (err) {
    console.error("saveRequestRules failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
