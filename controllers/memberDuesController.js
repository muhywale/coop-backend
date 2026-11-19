import pool from "../config/db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const compulsoryProducts = (coopId) =>
  pool.query(
    `SELECT id, name, expected_amount, COALESCE(due_frequency, 'monthly') AS frequency
     FROM products
     WHERE cooperative_id = $1 AND active = true AND is_compulsory = true AND category <> 'loan'
     ORDER BY name`,
    [coopId],
  );

// GET /api/member-dues?product_id=  : the compulsory accounts, and what each member pays into the chosen one
export const getMemberDues = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const products = await compulsoryProducts(coopId);
    const product = products.rows.find(
      (p) => p.id === Number(req.query.product_id),
    );
    if (!product) return res.json({ products: products.rows, members: [] });

    const members = await pool.query(
      `SELECT m.id, m.full_name, m.member_number,
              (SELECT d.amount FROM member_dues d
               WHERE d.member_id = m.id AND d.product_id = $2 AND d.cooperative_id = $1
                 AND d.effective_from <= CURRENT_DATE
               ORDER BY d.effective_from DESC LIMIT 1) AS custom
       FROM members m
       WHERE m.cooperative_id = $1 AND m.status = 'active'
       ORDER BY m.full_name`,
      [coopId, product.id],
    );

    const standard = parseFloat(product.expected_amount || 0);
    res.json({
      products: products.rows,
      product: {
        id: product.id,
        name: product.name,
        standard_amount: standard,
        frequency: product.frequency,
      },
      members: members.rows.map((m) => ({
        id: m.id,
        full_name: m.full_name,
        member_number: m.member_number,
        amount: m.custom !== null ? parseFloat(m.custom) : standard,
        custom: m.custom !== null,
      })),
    });
  } catch (err) {
    console.error("getMemberDues failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/member-dues   body: { product_id, effective_from, entries: [{ member_id, amount }] }
export const saveMemberDues = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const productId = Number(req.body.product_id);
    if (!DATE_RE.test(req.body.effective_from || ""))
      return res
        .status(400)
        .json({ error: "Choose the month these start from" });
    const effective = `${req.body.effective_from.slice(0, 7)}-01`;

    const entries = Array.isArray(req.body.entries)
      ? req.body.entries.slice(0, 2000)
      : [];
    if (entries.length === 0)
      return res.status(400).json({ error: "Nothing to save" });

    const products = await compulsoryProducts(coopId);
    if (!products.rows.some((p) => p.id === productId)) {
      return res.status(400).json({ error: "That isn't a compulsory account" });
    }

    const clean = [];
    for (const e of entries) {
      const amount = Math.round(parseFloat(e.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000000000) {
        return res
          .status(400)
          .json({ error: "Every amount must be zero or more" });
      }
      clean.push({ member_id: Number(e.member_id), amount });
    }

    // member ids come from the browser, so confirm they belong to this cooperative
    const members = await client.query(
      "SELECT id FROM members WHERE id = ANY($1::int[]) AND cooperative_id = $2",
      [clean.map((c) => c.member_id), coopId],
    );
    if (members.rows.length !== new Set(clean.map((c) => c.member_id)).size) {
      return res
        .status(400)
        .json({ error: "A member in the list wasn't found" });
    }

    await client.query("BEGIN");
    for (const c of clean) {
      await client.query(
        `INSERT INTO member_dues (cooperative_id, member_id, product_id, amount, effective_from)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id, product_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
        [coopId, c.member_id, productId, c.amount, effective],
      );
    }
    await client.query("COMMIT");

    const [y, m] = effective.split("-").map(Number);
    res.json({
      message: `Saved ${clean.length} amount(s), starting ${MONTHS[m - 1]} ${y}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveMemberDues failed:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
};
