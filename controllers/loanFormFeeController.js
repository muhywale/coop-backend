import pool from "../config/db.js";

export const getLoanFormFees = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const [setting, products, loanProducts, fees] = await Promise.all([
      pool.query(
        "SELECT form_fee_product_id FROM cooperative_rules WHERE cooperative_id = $1",
        [coopId],
      ),
      pool.query(
        `SELECT id, name, (linked_account_id IS NOT NULL) AS linked
         FROM products WHERE cooperative_id = $1 AND active = true AND category <> 'loan' ORDER BY name`,
        [coopId],
      ),
      pool.query(
        "SELECT id, name FROM products WHERE cooperative_id = $1 AND category = 'loan' AND active = true ORDER BY name",
        [coopId],
      ),
      pool.query(
        "SELECT loan_product_id, amount FROM loan_form_fees WHERE cooperative_id = $1",
        [coopId],
      ),
    ]);

    const feeMap = {};
    fees.rows.forEach((r) => {
      feeMap[r.loan_product_id] = parseFloat(r.amount);
    });

    res.json({
      form_fee_product_id: setting.rows[0]?.form_fee_product_id || null,
      products: products.rows,
      loan_products: loanProducts.rows.map((p) => ({
        id: p.id,
        name: p.name,
        amount: feeMap[p.id] || 0,
      })),
    });
  } catch (err) {
    console.error("getLoanFormFees failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const saveLoanFormFees = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const body = req.body || {};

    let productId = null;
    if (body.form_fee_product_id) {
      productId = Number(body.form_fee_product_id);
      const product = await client.query(
        `SELECT id FROM products
         WHERE id = $1 AND cooperative_id = $2 AND active = true AND category <> 'loan' AND linked_account_id IS NOT NULL`,
        [productId, coopId],
      );
      if (product.rows.length === 0) {
        return res.status(400).json({
          error:
            "That payment line isn't linked to a ledger account. Link it to your form-fee income account on the Products page first.",
        });
      }
    }

    const loans = await client.query(
      "SELECT id FROM products WHERE cooperative_id = $1 AND category = 'loan'",
      [coopId],
    );
    const validLoans = new Set(loans.rows.map((p) => p.id));

    const clean = [];
    for (const f of Array.isArray(body.fees) ? body.fees : []) {
      const loanId = Number(f.loan_product_id);
      if (!validLoans.has(loanId))
        return res
          .status(400)
          .json({ error: "That isn't a loan type of this cooperative" });
      const amount =
        f.amount === "" || f.amount == null
          ? 0
          : Math.round(parseFloat(f.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
        return res
          .status(400)
          .json({ error: "Every amount must be zero or more" });
      }
      clean.push({ loanId, amount });
    }
    if (!productId && clean.some((c) => c.amount > 0)) {
      return res
        .status(400)
        .json({
          error:
            "Choose the payment line the form amounts are collected through first",
        });
    }

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cooperative_rules (cooperative_id, form_fee_product_id) VALUES ($1, $2)
       ON CONFLICT (cooperative_id) DO UPDATE SET form_fee_product_id = EXCLUDED.form_fee_product_id`,
      [coopId, productId],
    );
    for (const c of clean) {
      if (c.amount > 0) {
        await client.query(
          `INSERT INTO loan_form_fees (cooperative_id, loan_product_id, amount) VALUES ($1, $2, $3)
           ON CONFLICT (loan_product_id) DO UPDATE SET amount = EXCLUDED.amount`,
          [coopId, c.loanId, c.amount],
        );
      } else {
        await client.query(
          "DELETE FROM loan_form_fees WHERE loan_product_id = $1 AND cooperative_id = $2",
          [c.loanId, coopId],
        );
      }
    }
    await client.query("COMMIT");
    res.json({ message: "Saved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveLoanFormFees failed:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
};
