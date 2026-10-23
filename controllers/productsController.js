import pool from "../config/db.js";

// Returns the id if it's a valid "other" product of this cooperative, null if blank, undefined if invalid
const checkInterestProduct = async (value, coopId, selfId) => {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!id || id === Number(selfId)) return undefined;
  const result = await pool.query(
    "SELECT id FROM products WHERE id = $1 AND cooperative_id = $2 AND category = 'other'",
    [id, coopId],
  );
  return result.rows.length > 0 ? id : undefined;
};

// [{ months_after: 0, rate: 3, basis: "principal" }, { months_after: 12, rate: 2, basis: "balance" }]
const cleanRules = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) => ({
      months_after: parseInt(r.months_after, 10),
      rate: parseFloat(r.rate),
      basis: r.basis === "balance" ? "balance" : "principal",
    }))
    .filter(
      (r) =>
        Number.isInteger(r.months_after) &&
        r.months_after >= 0 &&
        r.months_after <= 120 &&
        r.rate > 0 &&
        r.rate <= 100,
    )
    .slice(0, 10)
    .sort((a, b) => a.months_after - b.months_after);
};

const firstOffset = (value) => (Number(value) === 0 ? 0 : 1);

export const getProducts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE active = true AND cooperative_id = $1 ORDER BY category, name",
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const createProduct = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const {
      name,
      category,
      description,
      linked_account_id,
      is_compulsory,
      due_frequency,
    } = req.body;
    const interest_type = req.body.interest_type || null;
    const interest_rate = req.body.interest_rate
      ? parseFloat(req.body.interest_rate)
      : null;
    const expected_amount = req.body.expected_amount
      ? parseFloat(req.body.expected_amount)
      : null;

    const interestProductId = await checkInterestProduct(
      req.body.interest_product_id,
      coopId,
      null,
    );
    if (interestProductId === undefined) {
      return res
        .status(400)
        .json({
          error: "The interest payment product must be a fees & other product",
        });
    }
    const rules =
      interest_type === "scheduled" ? cleanRules(req.body.interest_rules) : [];
    if (interest_type === "scheduled" && rules.length === 0) {
      return res
        .status(400)
        .json({ error: "Add at least one interest charge with a rate" });
    }

    const result = await pool.query(
      `INSERT INTO products (name, category, interest_type, interest_rate, description, linked_account_id,
                             is_compulsory, expected_amount, due_frequency, interest_product_id,
                             first_payment_offset, interest_rules, cooperative_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13) RETURNING *`,
      [
        name,
        category,
        interest_type,
        interest_rate,
        description,
        linked_account_id || null,
        !!is_compulsory,
        expected_amount,
        due_frequency || "monthly",
        interestProductId,
        firstOffset(req.body.first_payment_offset),
        JSON.stringify(rules),
        coopId,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const { id } = req.params;
    const {
      name,
      category,
      interest_rate,
      description,
      linked_account_id,
      is_compulsory,
      expected_amount,
      due_frequency,
    } = req.body;
    const interest_type = req.body.interest_type || null;

    const interestProductId = await checkInterestProduct(
      req.body.interest_product_id,
      coopId,
      id,
    );
    if (interestProductId === undefined) {
      return res
        .status(400)
        .json({
          error: "The interest payment product must be a fees & other product",
        });
    }
    const rules =
      interest_type === "scheduled" ? cleanRules(req.body.interest_rules) : [];
    if (interest_type === "scheduled" && rules.length === 0) {
      return res
        .status(400)
        .json({ error: "Add at least one interest charge with a rate" });
    }

    const result = await pool.query(
      `UPDATE products SET name=$1, category=$2, interest_type=$3, interest_rate=$4, description=$5,
       linked_account_id=$6, is_compulsory=$7, expected_amount=$8, due_frequency=$9, interest_product_id=$10,
       first_payment_offset=$11, interest_rules=$12::jsonb
       WHERE id=$13 AND cooperative_id=$14 RETURNING *`,
      [
        name,
        category,
        interest_type,
        interest_rate,
        description,
        linked_account_id || null,
        !!is_compulsory,
        expected_amount ? parseFloat(expected_amount) : null,
        due_frequency || "monthly",
        interestProductId,
        firstOffset(req.body.first_payment_offset),
        JSON.stringify(rules),
        id,
        coopId,
      ],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Product not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const deactivateProduct = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const { id } = req.params;
    await pool.query(
      "UPDATE products SET active = false WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    // A loan product can no longer point at an interest line that's switched off
    await pool.query(
      "UPDATE products SET interest_product_id = NULL WHERE interest_product_id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    res.json({ message: "Product deactivated" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
