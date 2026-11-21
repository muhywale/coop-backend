import pool from "../config/db.js";
import { postJournal, getDefaultCashAccount } from "../utils/journal.js";

const MAX_PENDING = 5;
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

const text = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) =>
  `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const amountOf = (v) => {
  const n = Math.round(parseFloat(v) * 100) / 100;
  return Number.isFinite(n) && n > 0 && n <= 10000000000 ? n : null;
};
const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => localDate(new Date());
const nextMonthStart = () => {
  const d = new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth() + 1, 1));
};
const monthLabel = (dateStr) => {
  const [y, m] = dateStr.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

// Savings accounts members may ask to withdraw from
const getWithdrawableIds = async (db, coopId) => {
  const result = await db.query(
    "SELECT withdrawable_product_ids FROM cooperative_rules WHERE cooperative_id = $1",
    [coopId],
  );
  return result.rows[0]?.withdrawable_product_ids || [];
};

// Borrowing rules, one per loan type: { loan_product_id: { multiple, savings_product_ids, deduct_mode } }
const getBorrowRules = async (db, coopId) => {
  const result = await db.query(
    "SELECT loan_product_id, multiple, savings_product_ids, deduct_mode FROM loan_borrowing_rules WHERE cooperative_id = $1",
    [coopId],
  );
  const map = {};
  result.rows.forEach((r) => {
    map[r.loan_product_id] = {
      multiple: parseFloat(r.multiple),
      savings_product_ids: r.savings_product_ids || [],
      deduct_mode: r.deduct_mode,
    };
  });
  return map;
};

// A member's balance in every active savings account
const savingsBalances = async (db, coopId, memberId) => {
  const result = await db.query(
    `SELECT p.id, p.name,
            COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END), 0) AS balance
     FROM products p
     LEFT JOIN contributions c
       ON c.product_id = p.id AND c.member_id = $2 AND c.cooperative_id = $1
      AND c.type IN ('savings', 'opening_balance', 'withdrawal')
     WHERE p.cooperative_id = $1 AND p.category = 'savings' AND p.active = true
     GROUP BY p.id, p.name
     ORDER BY p.name`,
    [coopId, memberId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    balance: round2(parseFloat(r.balance)),
  }));
};

// What the member still owes on active loans: in total, and per loan type
const outstandingLoans = async (db, coopId, memberId) => {
  const result = await db.query(
    `SELECT l.product_id,
            COALESCE(SUM((l.principal + COALESCE(l.interest_amount, 0)) - COALESCE(r.repaid, 0)), 0) AS outstanding,
            COUNT(*)::int AS n
     FROM loans l
     LEFT JOIN (
       SELECT loan_id, SUM(amount) AS repaid FROM loan_repayments WHERE cooperative_id = $2 GROUP BY loan_id
     ) r ON r.loan_id = l.id
     WHERE l.member_id = $1 AND l.cooperative_id = $2 AND l.status = 'active'
     GROUP BY l.product_id`,
    [memberId, coopId],
  );
  const byProduct = {};
  let total = 0;
  let count = 0;
  result.rows.forEach((r) => {
    const value = round2(parseFloat(r.outstanding));
    byProduct[r.product_id] = value;
    total += value;
    count += r.n;
  });
  return { total: round2(total), count, byProduct };
};

// The usual borrowing limit for one loan type. It is a guide only: nothing is blocked because of it.
const guideFor = (rule, balances, owed, loanProductId) => {
  if (!rule) return null;
  const specific = rule.savings_product_ids.length > 0;
  const counted = balances.filter(
    (b) => !specific || rule.savings_product_ids.includes(b.id),
  );
  const qualifying = round2(
    counted.reduce((sum, b) => sum + Math.max(b.balance, 0), 0),
  );
  const gross = round2(qualifying * rule.multiple);
  const deducted =
    rule.deduct_mode === "all"
      ? owed.total
      : rule.deduct_mode === "same"
        ? owed.byProduct[loanProductId] || 0
        : 0;
  return {
    multiple: rule.multiple,
    qualifying_savings: qualifying,
    savings_label:
      specific && counted.length > 0
        ? counted.map((b) => b.name).join(" + ")
        : "savings",
    deduct_mode: rule.deduct_mode,
    outstanding: round2(deducted),
    limit: round2(Math.max(gross - deducted, 0)),
  };
};

const interestLabel = (p) => {
  if (p.interest_type === "scheduled") return "scheduled interest";
  if (p.interest_type === "reducing_balance")
    return `${parseFloat(p.interest_rate || 0)}% per month, reducing`;
  if (p.interest_type === "one_off")
    return `${parseFloat(p.interest_rate || 0)}% one-off`;
  return "";
};

// What a member is expected to pay into a compulsory account today: their own amount, else the standard one
const currentDueAmount = async (db, coopId, memberId, productId) => {
  const own = await db.query(
    `SELECT amount FROM member_dues
     WHERE member_id = $1 AND product_id = $2 AND cooperative_id = $3 AND effective_from <= CURRENT_DATE
     ORDER BY effective_from DESC LIMIT 1`,
    [memberId, productId, coopId],
  );
  if (own.rows.length > 0) return parseFloat(own.rows[0].amount);
  const product = await db.query(
    "SELECT expected_amount FROM products WHERE id = $1 AND cooperative_id = $2",
    [productId, coopId],
  );
  return parseFloat(product.rows[0]?.expected_amount || 0);
};

// Records a withdrawal exactly like the Withdrawal page: the contribution row plus its ledger entry
const postWithdrawal = async (
  client,
  { coopId, memberId, memberName, productId, amount, date },
) => {
  const productResult = await client.query(
    "SELECT id, name, linked_account_id FROM products WHERE id = $1 AND cooperative_id = $2 AND category = 'savings' AND active = true",
    [productId, coopId],
  );
  if (productResult.rows.length === 0)
    throw new Error("That savings account is no longer available");
  const product = productResult.rows[0];
  if (!product.linked_account_id) {
    throw new Error(
      `${product.name} isn't linked to a ledger account yet. Link it on the Products page first.`,
    );
  }

  const balance = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN -amount ELSE amount END), 0) AS balance
     FROM contributions
     WHERE member_id = $1 AND product_id = $2 AND cooperative_id = $3
       AND type IN ('savings', 'opening_balance', 'withdrawal')`,
    [memberId, productId, coopId],
  );
  const available = parseFloat(balance.rows[0].balance);
  if (amount > available + 0.005)
    throw new Error(`Insufficient balance. Available: ${money(available)}`);

  const cashAccountId = await getDefaultCashAccount(client, coopId);
  const inserted = await client.query(
    `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
     VALUES ($1, $2, 'withdrawal', $3, 'Approved member request', $4, $5) RETURNING id`,
    [memberId, amount, date, productId, coopId],
  );
  await postJournal(client, {
    entry_date: date,
    description: `${product.name} withdrawal — ${memberName}`,
    source: "withdrawal",
    source_id: inserted.rows[0].id,
    cooperativeId: coopId,
    lines: [
      { account_id: product.linked_account_id, debit: amount, credit: 0 },
      { account_id: cashAccountId, debit: 0, credit: amount },
    ],
  });
};

// One entry per request type: how to check what the member sent, and what approval does.
const TYPES = {
  contact: {
    label: "Update phone or email",
    async validate(body) {
      const phone = text(body.phone, 20);
      const email = text(body.email, 120).toLowerCase();
      if (!phone && !email)
        return { error: "Enter a new phone number or email" };
      if (phone && !/^[0-9+()\s-]{6,20}$/.test(phone))
        return { error: "That phone number doesn't look right" };
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { error: "That email address doesn't look right" };
      return { details: { phone: phone || null, email: email || null } };
    },
    async approve(client, { coopId, request }) {
      const d = request.details;
      await client.query(
        "UPDATE members SET phone = COALESCE($1, phone), email = COALESCE($2, email) WHERE id = $3 AND cooperative_id = $4",
        [d.phone, d.email, request.member_id, coopId],
      );
      return {
        status: "done",
        message: `Contact details updated for ${request.full_name}.`,
      };
    },
  },

  withdrawal: {
    label: "Withdraw savings",
    async validate(body, { coopId, memberId }) {
      const withdrawable = await getWithdrawableIds(pool, coopId);
      const productId = Number(body.product_id);
      const amount = amountOf(body.amount);
      if (!amount) return { error: "Enter the amount you want to withdraw" };
      if (!withdrawable.includes(productId)) {
        return { error: "Withdrawals from that account can't be requested" };
      }
      const balances = await savingsBalances(pool, coopId, memberId);
      const account = balances.find((b) => b.id === productId);
      if (!account) return { error: "That account wasn't found" };
      if (amount > account.balance + 0.005) {
        return {
          error: `You asked for ${money(amount)} but your ${account.name} balance is ${money(account.balance)}`,
        };
      }
      return {
        details: { product_id: productId, product_name: account.name, amount },
      };
    },
    async approve(client, { coopId, request, body }) {
      const d = request.details;
      const date = DATE_RE.test(body.date || "") ? body.date : today();
      await postWithdrawal(client, {
        coopId,
        memberId: request.member_id,
        memberName: request.full_name,
        productId: d.product_id,
        amount: d.amount,
        date,
      });
      return {
        status: "done",
        message: `Withdrawal of ${money(d.amount)} from ${d.product_name} recorded for ${request.full_name}.`,
        details: { ...d, paid_on: date },
      };
    },
  },

  contribution: {
    label: "Change monthly contribution",
    async validate(body, { coopId }) {
      const productId = Number(body.product_id);
      const amount = amountOf(body.amount);
      if (!amount) return { error: "Enter the new amount you want to pay" };
      const product = await pool.query(
        `SELECT id, name, COALESCE(due_frequency, 'monthly') AS frequency
         FROM products
         WHERE id = $1 AND cooperative_id = $2 AND category = 'savings' AND is_compulsory = true AND active = true`,
        [productId, coopId],
      );
      if (product.rows.length === 0)
        return { error: "You can't change the amount for that account" };
      const p = product.rows[0];
      return {
        details: {
          product_id: p.id,
          product_name: p.name,
          frequency: p.frequency,
          amount,
        },
      };
    },
    async approve(client, { coopId, request, body }) {
      const d = request.details;
      const effective = DATE_RE.test(body.effective_from || "")
        ? `${body.effective_from.slice(0, 7)}-01`
        : nextMonthStart();
      await client.query(
        `INSERT INTO member_dues (cooperative_id, member_id, product_id, amount, effective_from)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id, product_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
        [coopId, request.member_id, d.product_id, d.amount, effective],
      );
      return {
        status: "done",
        message: `${request.full_name} will pay ${money(d.amount)} into ${d.product_name} from ${monthLabel(effective)}.`,
        details: { ...d, effective_from: effective },
      };
    },
  },

  loan: {
    label: "Loan application",
    async validate(body, { coopId, memberId }) {
      const productId = Number(body.product_id);
      const amount = amountOf(body.amount);
      if (!amount) return { error: "Enter the amount you want to borrow" };

      const product = await pool.query(
        "SELECT id, name FROM products WHERE id = $1 AND cooperative_id = $2 AND category = 'loan' AND active = true",
        [productId, coopId],
      );
      if (product.rows.length === 0) return { error: "Choose a loan type" };

      const duration = parseInt(body.duration_value, 10);
      const durationValue =
        Number.isInteger(duration) && duration > 0 && duration <= 120
          ? duration
          : null;
      const durationUnit = body.duration_unit === "weeks" ? "weeks" : "months";

      // Kept with the request so the admin can see what the guide said when it was sent
      const [rules, balances, owed] = await Promise.all([
        getBorrowRules(pool, coopId),
        savingsBalances(pool, coopId, memberId),
        outstandingLoans(pool, coopId, memberId),
      ]);
      const guide = guideFor(rules[productId], balances, owed, productId);

      return {
        details: {
          product_id: product.rows[0].id,
          product_name: product.rows[0].name,
          amount,
          duration_value: durationValue,
          duration_unit: durationUnit,
          purpose: text(body.purpose, 300) || null,
          guide_limit: guide ? guide.limit : null,
        },
      };
    },
    // Approval is a decision only. The loan itself is issued on the Loans page.
    async approve(client, { request, body }) {
      const d = request.details;
      const approved = amountOf(body.approved_amount) || d.amount;
      const duration = parseInt(body.approved_duration_value, 10);
      const unit =
        body.approved_duration_unit === "weeks"
          ? "weeks"
          : body.approved_duration_unit === "months"
            ? "months"
            : d.duration_unit || "months";
      return {
        status: "approved",
        message: `Loan approved for ${money(approved)}. Issue it on the Loans page, then mark this request as issued.`,
        details: {
          ...d,
          approved_amount: approved,
          approved_duration_value:
            Number.isInteger(duration) && duration > 0 && duration <= 120
              ? duration
              : d.duration_value || null,
          approved_duration_unit: unit,
        },
      };
    },
  },
};

const typeOf = (key) =>
  Object.prototype.hasOwnProperty.call(TYPES, key) ? TYPES[key] : null;
const withLabel = (row) => ({
  ...row,
  type_label: typeOf(row.type)?.label || row.type,
});

// ---------- Member ----------

// What the member can ask for right now (used to build their forms)
export const getRequestOptions = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const [
      balances,
      withdrawable,
      owed,
      borrowRules,
      pending,
      dues,
      loanProducts,
    ] = await Promise.all([
      savingsBalances(pool, coopId, memberId),
      getWithdrawableIds(pool, coopId),
      outstandingLoans(pool, coopId, memberId),
      getBorrowRules(pool, coopId),
      pool.query(
        "SELECT COUNT(*)::int AS n FROM member_requests WHERE member_id = $1 AND status = 'pending'",
        [memberId],
      ),
      pool.query(
        `SELECT p.id, p.name, COALESCE(p.due_frequency, 'monthly') AS frequency,
                COALESCE(
                  (SELECT d.amount FROM member_dues d
                   WHERE d.member_id = $2 AND d.product_id = p.id AND d.cooperative_id = $1
                     AND d.effective_from <= CURRENT_DATE
                   ORDER BY d.effective_from DESC LIMIT 1),
                  p.expected_amount, 0) AS current_amount
         FROM products p
         WHERE p.cooperative_id = $1 AND p.category = 'savings' AND p.is_compulsory = true AND p.active = true
         ORDER BY p.name`,
        [coopId, memberId],
      ),
      pool.query(
        `SELECT id, name, interest_type, interest_rate FROM products
         WHERE cooperative_id = $1 AND category = 'loan' AND active = true ORDER BY name`,
        [coopId],
      ),
    ]);
    res.json({
      withdrawable: balances.filter(
        (b) => withdrawable.includes(b.id) && b.balance > 0,
      ),
      contribution_products: dues.rows.map((p) => ({
        id: p.id,
        name: p.name,
        frequency: p.frequency,
        current_amount: parseFloat(p.current_amount),
      })),
      // Each loan type carries its own guide, because the multiple and the savings that count differ by type
      loan_products: loanProducts.rows.map((p) => ({
        id: p.id,
        name: p.name,
        interest_label: interestLabel(p),
        guide: guideFor(borrowRules[p.id], balances, owed, p.id),
      })),
      pending_count: pending.rows[0].n,
      max_pending: MAX_PENDING,
    });
  } catch (err) {
    console.error("getRequestOptions failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const createRequest = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const type = typeOf(req.body?.type);
    if (!type)
      return res
        .status(400)
        .json({ error: "That kind of request isn't available" });

    const pending = await pool.query(
      "SELECT COUNT(*)::int AS n FROM member_requests WHERE member_id = $1 AND status = 'pending'",
      [memberId],
    );
    if (pending.rows[0].n >= MAX_PENDING) {
      return res
        .status(400)
        .json({
          error: `You already have ${MAX_PENDING} requests waiting. Please wait for your admin to respond.`,
        });
    }

    const checked = await type.validate(req.body, { coopId, memberId });
    if (checked.error) return res.status(400).json({ error: checked.error });

    await pool.query(
      `INSERT INTO member_requests (cooperative_id, member_id, type, details, member_note)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        coopId,
        memberId,
        req.body.type,
        JSON.stringify(checked.details),
        text(req.body.note, 500) || null,
      ],
    );
    res
      .status(201)
      .json({ message: "Request sent. Your admin will respond here." });
  } catch (err) {
    console.error("createRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const listMyRequests = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, details, member_note, status, admin_note, created_at, decided_at
       FROM member_requests
       WHERE member_id = $1 AND cooperative_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.memberId, req.user.cooperativeId],
    );
    res.json(result.rows.map(withLabel));
  } catch (err) {
    console.error("listMyRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const cancelMyRequest = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE member_requests SET status = 'cancelled', decided_at = NOW()
       WHERE id = $1 AND member_id = $2 AND cooperative_id = $3 AND status = 'pending'
       RETURNING id`,
      [req.params.id, req.user.memberId, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "That request can't be cancelled" });
    res.json({ message: "Request cancelled" });
  } catch (err) {
    console.error("cancelMyRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ---------- Admin ----------

export const listRequests = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const allowed = ["pending", "approved", "done", "declined", "cancelled"];
    const status =
      req.query.status === "all"
        ? null
        : allowed.includes(req.query.status)
          ? req.query.status
          : "pending";

    const result = await pool.query(
      `SELECT r.id, r.type, r.details, r.member_note, r.status, r.admin_note, r.created_at, r.decided_at,
              r.member_id, m.full_name, m.member_number, m.phone AS current_phone, m.email AS current_email
       FROM member_requests r
       JOIN members m ON m.id = r.member_id
       WHERE r.cooperative_id = $1 AND ($2::text IS NULL OR r.status = $2)
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC
       LIMIT 200`,
      [coopId, status],
    );

    const rows = result.rows.map(withLabel);
    const borrowRules = await getBorrowRules(pool, coopId);

    // The admin sees things as they are now, not as they were when the member asked
    for (const r of rows) {
      if (r.status === "pending" && r.type === "withdrawal") {
        const balances = await savingsBalances(pool, coopId, r.member_id);
        r.context = {
          balance:
            balances.find((b) => b.id === r.details.product_id)?.balance ?? 0,
        };
      } else if (r.status === "pending" && r.type === "contribution") {
        r.context = {
          current_amount: await currentDueAmount(
            pool,
            coopId,
            r.member_id,
            r.details.product_id,
          ),
        };
      } else if (
        r.type === "loan" &&
        ["pending", "approved"].includes(r.status)
      ) {
        const [balances, owed] = await Promise.all([
          savingsBalances(pool, coopId, r.member_id),
          outstandingLoans(pool, coopId, r.member_id),
        ]);
        r.context = {
          guide: guideFor(
            borrowRules[r.details.product_id],
            balances,
            owed,
            r.details.product_id,
          ),
          savings_total: round2(
            balances.reduce((sum, b) => sum + Math.max(b.balance, 0), 0),
          ),
          outstanding: owed.total,
          active_loans: owed.count,
        };
      }
    }
    res.json(rows);
  } catch (err) {
    console.error("listRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const countRequests = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM member_requests WHERE cooperative_id = $1 AND status = 'pending'",
      [req.user.cooperativeId],
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("countRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const approveRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT r.*, m.full_name
       FROM member_requests r JOIN members m ON m.id = r.member_id
       WHERE r.id = $1 AND r.cooperative_id = $2
       FOR UPDATE OF r`,
      [req.params.id, coopId],
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }
    const request = found.rows[0];
    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "This request has already been handled" });
    }
    const type = typeOf(request.type);
    if (!type) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "This kind of request can't be approved" });
    }

    const outcome = await type.approve(client, {
      coopId,
      request,
      body: req.body || {},
    });

    await client.query(
      `UPDATE member_requests
       SET status = $1, details = $2::jsonb, admin_note = $3, decided_by = $4, decided_at = NOW()
       WHERE id = $5`,
      [
        outcome.status,
        JSON.stringify(outcome.details || request.details),
        text(req.body?.admin_note, 500) || null,
        req.user.userId,
        request.id,
      ],
    );
    await client.query("COMMIT");
    res.json({ message: outcome.message });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approveRequest failed:", err);
    if (err.code === "23505")
      return res
        .status(409)
        .json({
          error: "That email address is already used by another member",
        });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const declineRequest = async (req, res) => {
  try {
    const note = text(req.body?.admin_note, 500);
    if (!note)
      return res.status(400).json({ error: "Give the member a short reason" });

    const result = await pool.query(
      `UPDATE member_requests
       SET status = 'declined', admin_note = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3 AND cooperative_id = $4 AND status = 'pending'
       RETURNING id`,
      [note, req.user.userId, req.params.id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ error: "That request isn't waiting any more" });
    res.json({ message: "Request declined" });
  } catch (err) {
    console.error("declineRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// A loan application that was approved and has now been issued on the Loans page
export const completeRequest = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE member_requests
       SET status = 'done', details = details || $1::jsonb
       WHERE id = $2 AND cooperative_id = $3 AND type = 'loan' AND status = 'approved'
       RETURNING id`,
      [
        JSON.stringify({ issued_on: today() }),
        req.params.id,
        req.user.cooperativeId,
      ],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ error: "That request isn't waiting to be issued" });
    res.json({ message: "Marked as issued" });
  } catch (err) {
    console.error("completeRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
