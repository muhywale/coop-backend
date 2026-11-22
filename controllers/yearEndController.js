import pool from "../config/db.js";

const round2 = (n) => Math.round(n * 100) / 100;
const parseYear = (v) => {
  const y = parseInt(v, 10);
  return y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
};

const TOTAL_KEYS = [
  "total_savings",
  "paid_in",
  "withdrawn",
  "interest_oneoff",
  "interest_paid",
  "interest_total",
  "loan_repaid",
  "loan_outstanding",
];

// { member_id: value } from rows shaped { member_id, <field> }
const byMember = (rows, field) => {
  const map = {};
  rows.forEach((r) => {
    map[r.member_id] = parseFloat(r[field] || 0);
  });
  return map;
};

export const getYearEndReport = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const year = parseYear(req.query.year);
    const start = `${year}-01-01`;
    const end = `${year + 1}-01-01`;

    // Interest lines (e.g. "Building Loan Interest") are payments received, not savings
    const interestLines = await pool.query(
      "SELECT DISTINCT interest_product_id AS id FROM products WHERE cooperative_id = $1 AND interest_product_id IS NOT NULL",
      [coopId],
    );
    const interestIds = interestLines.rows.map((r) => r.id);

    const [
      products,
      members,
      closing,
      flow,
      interestPaid,
      oneOff,
      repaid,
      owed,
    ] = await Promise.all([
      pool.query(
        `SELECT id, name FROM products
         WHERE cooperative_id = $1 AND category = 'savings' AND id <> ALL($2::int[])
         ORDER BY name`,
        [coopId, interestIds],
      ),
      pool.query(
        "SELECT id, full_name, member_number, status FROM members WHERE cooperative_id = $1 ORDER BY full_name",
        [coopId],
      ),
      // Balance in each savings account as at 31 December
      pool.query(
        `SELECT c.member_id, c.product_id,
                SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END) AS balance
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.cooperative_id = $1 AND p.category = 'savings' AND p.id <> ALL($2::int[])
           AND c.type IN ('savings', 'opening_balance', 'withdrawal') AND c.contribution_date < $3::date
         GROUP BY c.member_id, c.product_id`,
        [coopId, interestIds, end],
      ),
      // Deposits and withdrawals during the year
      pool.query(
        `SELECT c.member_id,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type = 'savings'), 0) AS paid_in,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type = 'withdrawal'), 0) AS withdrawn
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.cooperative_id = $1 AND p.category = 'savings' AND p.id <> ALL($2::int[])
           AND c.contribution_date >= $3::date AND c.contribution_date < $4::date
         GROUP BY c.member_id`,
        [coopId, interestIds, start, end],
      ),
      // Interest collected through separate payment lines
      pool.query(
        `SELECT member_id, SUM(amount) AS total FROM contributions
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[]) AND type IN ('savings', 'other')
           AND contribution_date >= $3::date AND contribution_date < $4::date
         GROUP BY member_id`,
        [coopId, interestIds, start, end],
      ),
      // One-off interest added to loans issued this year
      pool.query(
        `SELECT member_id, SUM(COALESCE(interest_amount, 0)) AS total FROM loans
         WHERE cooperative_id = $1 AND date_issued >= $2::date AND date_issued < $3::date
         GROUP BY member_id`,
        [coopId, start, end],
      ),
      pool.query(
        `SELECT l.member_id, SUM(r.amount) AS total
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
         WHERE r.cooperative_id = $1 AND r.repayment_date >= $2::date AND r.repayment_date < $3::date
         GROUP BY l.member_id`,
        [coopId, start, end],
      ),
      // What each member still owed on 31 December, counting loans cleared since
      pool.query(
        `SELECT l.member_id,
                SUM(GREATEST((l.principal + COALESCE(l.interest_amount, 0)) - COALESCE(rp.repaid, 0), 0)) AS total
         FROM loans l
         LEFT JOIN (
           SELECT loan_id, SUM(amount) AS repaid FROM loan_repayments
           WHERE cooperative_id = $1 AND repayment_date < $2::date GROUP BY loan_id
         ) rp ON rp.loan_id = l.id
         WHERE l.cooperative_id = $1 AND l.date_issued < $2::date
         GROUP BY l.member_id`,
        [coopId, end],
      ),
    ]);

    const closingMap = {};
    closing.rows.forEach((r) => {
      if (!closingMap[r.member_id]) closingMap[r.member_id] = {};
      closingMap[r.member_id][r.product_id] = parseFloat(r.balance);
    });
    const paidInMap = byMember(flow.rows, "paid_in");
    const withdrawnMap = byMember(flow.rows, "withdrawn");
    const interestPaidMap = byMember(interestPaid.rows, "total");
    const oneOffMap = byMember(oneOff.rows, "total");
    const repaidMap = byMember(repaid.rows, "total");
    const owedMap = byMember(owed.rows, "total");

    const rows = members.rows
      .map((m) => {
        const balances = {};
        let totalSavings = 0;
        products.rows.forEach((p) => {
          const v = round2((closingMap[m.id] && closingMap[m.id][p.id]) || 0);
          if (v !== 0) balances[p.id] = v;
          totalSavings += v;
        });
        const oneOffInterest = round2(oneOffMap[m.id] || 0);
        const paidInterest = round2(interestPaidMap[m.id] || 0);
        return {
          member_id: m.id,
          member_number: m.member_number,
          full_name: m.full_name,
          status: m.status,
          balances,
          total_savings: round2(totalSavings),
          paid_in: round2(paidInMap[m.id] || 0),
          withdrawn: round2(withdrawnMap[m.id] || 0),
          interest_oneoff: oneOffInterest,
          interest_paid: paidInterest,
          interest_total: round2(oneOffInterest + paidInterest),
          loan_repaid: round2(repaidMap[m.id] || 0),
          loan_outstanding: round2(owedMap[m.id] || 0),
        };
      })
      // Leave out members with nothing at all this year
      .filter(
        (r) =>
          Object.keys(r.balances).length > 0 ||
          TOTAL_KEYS.some((k) => Math.abs(r[k]) > 0.005),
      );

    // Only show savings accounts somebody actually has a balance in
    const shownProducts = products.rows.filter((p) =>
      rows.some((r) => r.balances[p.id]),
    );

    const totals = { balances: {} };
    TOTAL_KEYS.forEach((k) => {
      totals[k] = 0;
    });
    rows.forEach((r) => {
      shownProducts.forEach((p) => {
        totals.balances[p.id] = round2(
          (totals.balances[p.id] || 0) + (r.balances[p.id] || 0),
        );
      });
      TOTAL_KEYS.forEach((k) => {
        totals[k] = round2(totals[k] + r[k]);
      });
    });

    res.json({ year, products: shownProducts, rows, totals });
  } catch (err) {
    console.error("getYearEndReport failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
