import pool from "../config/db.js";

const round2 = (n) => Math.round(n * 100) / 100;
const parseYear = (value) => {
  const y = parseInt(value, 10);
  return y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
};

const DESCRIPTION = {
  savings: "Deposit",
  other: "Payment",
  withdrawal: "Withdrawal",
  repayment: "Loan repayment",
};
const PREFIX = {
  savings: "RC",
  other: "RC",
  withdrawal: "WD",
  repayment: "RP",
};
const receiptNo = (type, id) =>
  `${PREFIX[type]}-${String(id).padStart(6, "0")}`;

// The member's own payments for a year (carried-forward balances are not payments)
export const listMyPayments = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const year = parseYear(req.query.year);

    const result = await pool.query(
      `SELECT 'contribution' AS kind, c.id, to_char(c.contribution_date, 'YYYY-MM-DD') AS pay_date,
              c.type, p.name AS product_name, c.amount
       FROM contributions c LEFT JOIN products p ON p.id = c.product_id
       WHERE c.member_id = $1 AND c.cooperative_id = $2 AND c.type IN ('savings', 'other', 'withdrawal')
         AND c.contribution_date >= $3::date AND c.contribution_date < $4::date
       UNION ALL
       SELECT 'repayment', r.id, to_char(r.repayment_date, 'YYYY-MM-DD'), 'repayment', p.name, r.amount
       FROM loan_repayments r
       JOIN loans l ON l.id = r.loan_id
       JOIN products p ON p.id = l.product_id
       WHERE l.member_id = $1 AND r.cooperative_id = $2
         AND r.repayment_date >= $3::date AND r.repayment_date < $4::date
       ORDER BY pay_date DESC, id DESC`,
      [memberId, coopId, `${year}-01-01`, `${year + 1}-01-01`],
    );

    res.json({
      year,
      payments: result.rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        date: r.pay_date,
        description: DESCRIPTION[r.type] || "Payment",
        product: r.product_name || "",
        amount: parseFloat(r.amount),
        outgoing: r.type === "withdrawal",
      })),
    });
  } catch (err) {
    console.error("listMyPayments failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// One receipt, built from the cooperative's records
export const getReceipt = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const { kind } = req.params;
    const id = parseInt(req.params.id, 10);
    if (!id || !["contribution", "repayment"].includes(kind)) {
      return res.status(404).json({ error: "Receipt not found" });
    }

    const coop = await pool.query(
      "SELECT name, contact_phone FROM cooperatives WHERE id = $1",
      [coopId],
    );
    const cooperative = {
      name: coop.rows[0]?.name || "",
      phone: coop.rows[0]?.contact_phone || "",
    };

    if (kind === "contribution") {
      const found = await pool.query(
        `SELECT c.id, c.type, c.amount, c.product_id, to_char(c.contribution_date, 'YYYY-MM-DD') AS pay_date,
                p.name AS product_name, p.category, m.full_name, m.member_number
         FROM contributions c
         LEFT JOIN products p ON p.id = c.product_id
         JOIN members m ON m.id = c.member_id
         WHERE c.id = $1 AND c.member_id = $2 AND c.cooperative_id = $3 AND c.type IN ('savings', 'other', 'withdrawal')`,
        [id, memberId, coopId],
      );
      if (found.rows.length === 0)
        return res.status(404).json({ error: "Receipt not found" });
      const c = found.rows[0];

      let balance = null;
      if (c.category === "savings") {
        const bal = await pool.query(
          `SELECT COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN -amount ELSE amount END), 0) AS balance
           FROM contributions
           WHERE member_id = $1 AND product_id = $2 AND cooperative_id = $3
             AND type IN ('savings', 'opening_balance', 'withdrawal')
             AND (contribution_date < $4::date OR (contribution_date = $4::date AND id <= $5))`,
          [memberId, c.product_id, coopId, c.pay_date, c.id],
        );
        balance = {
          label: `Balance on ${c.product_name} after this ${c.type === "withdrawal" ? "withdrawal" : "payment"}`,
          amount: round2(parseFloat(bal.rows[0].balance)),
        };
      }

      return res.json({
        cooperative,
        receipt_no: receiptNo(c.type, c.id),
        title: c.type === "withdrawal" ? "WITHDRAWAL SLIP" : "PAYMENT RECEIPT",
        date: c.pay_date,
        member: { full_name: c.full_name, member_number: c.member_number },
        description: DESCRIPTION[c.type],
        product: c.product_name || "",
        amount: parseFloat(c.amount),
        amount_label:
          c.type === "withdrawal"
            ? "Amount paid out to you"
            : "Amount received",
        balance,
      });
    }

    const found = await pool.query(
      `SELECT r.id, r.amount, r.loan_id, to_char(r.repayment_date, 'YYYY-MM-DD') AS pay_date,
              l.principal, l.interest_amount, p.name AS product_name, m.full_name, m.member_number
       FROM loan_repayments r
       JOIN loans l ON l.id = r.loan_id
       JOIN products p ON p.id = l.product_id
       JOIN members m ON m.id = l.member_id
       WHERE r.id = $1 AND l.member_id = $2 AND r.cooperative_id = $3`,
      [id, memberId, coopId],
    );
    if (found.rows.length === 0)
      return res.status(404).json({ error: "Receipt not found" });
    const r = found.rows[0];

    const paid = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS repaid FROM loan_repayments
       WHERE loan_id = $1 AND cooperative_id = $2
         AND (repayment_date < $3::date OR (repayment_date = $3::date AND id <= $4))`,
      [r.loan_id, coopId, r.pay_date, r.id],
    );
    const owed = parseFloat(r.principal) + parseFloat(r.interest_amount || 0);

    res.json({
      cooperative,
      receipt_no: receiptNo("repayment", r.id),
      title: "PAYMENT RECEIPT",
      date: r.pay_date,
      member: { full_name: r.full_name, member_number: r.member_number },
      description: "Loan repayment",
      product: r.product_name,
      amount: parseFloat(r.amount),
      amount_label: "Amount received",
      balance: {
        label: `Balance on this ${r.product_name} after this payment`,
        amount: round2(Math.max(owed - parseFloat(paid.rows[0].repaid), 0)),
      },
    });
  } catch (err) {
    console.error("getReceipt failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
