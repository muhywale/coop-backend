import pool from "../config/db.js";

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const round2 = (n) => Math.round(n * 100) / 100;

const parseYear = (value) => {
  const y = parseInt(value, 10);
  return y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
};

// One ledger-book account: B/F, twelve months, an optional "I & E" line,
// the balance carried down on the lighter side, and equal totals underneath.
const buildLedger = ({
  title,
  bfDr = 0,
  bfCr = 0,
  months = {},
  interest = 0,
}) => {
  const rows = [{ label: "B/F", dr: round2(bfDr), cr: round2(bfCr) }];
  let dr = bfDr;
  let cr = bfCr;

  MONTHS.forEach((label, i) => {
    const m = months[i + 1] || { dr: 0, cr: 0 };
    rows.push({ label, dr: round2(m.dr), cr: round2(m.cr) });
    dr += m.dr;
    cr += m.cr;
  });

  if (interest > 0.004) {
    rows.push({ label: "I & E", dr: round2(interest), cr: 0, highlight: true });
    dr += interest;
  }

  dr = round2(dr);
  cr = round2(cr);
  return {
    title,
    rows,
    totals: { dr, cr },
    balance: { side: dr > cr ? "cr" : "dr", amount: round2(Math.abs(dr - cr)) },
    grand: Math.max(dr, cr),
  };
};

// ---------- Society books: one account ----------

export const getAccountStatement = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const { accountId } = req.params;
    const year = parseYear(req.query.year);
    const start = `${year}-01-01`;
    const end = `${year + 1}-01-01`;

    const account = await pool.query(
      "SELECT id, code, name, account_type, normal_balance FROM chart_of_accounts WHERE id = $1 AND cooperative_id = $2",
      [accountId, coopId],
    );
    if (account.rows.length === 0)
      return res.status(404).json({ error: "Account not found" });

    // Everything before 1 January is the brought-forward balance
    const before = await pool.query(
      `SELECT COALESCE(SUM(l.debit), 0) AS d, COALESCE(SUM(l.credit), 0) AS c
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = $1 AND l.cooperative_id = $2 AND je.entry_date < $3::date`,
      [accountId, coopId, start],
    );
    const net = parseFloat(before.rows[0].d) - parseFloat(before.rows[0].c);

    // Interest added to loans is pulled out of the months and shown once, as "I & E"
    const monthly = await pool.query(
      `SELECT EXTRACT(MONTH FROM je.entry_date)::int AS month,
              COALESCE(SUM(l.debit) FILTER (WHERE je.source IS DISTINCT FROM 'loan_interest'), 0) AS dr,
              COALESCE(SUM(l.debit) FILTER (WHERE je.source = 'loan_interest'), 0) AS interest,
              COALESCE(SUM(l.credit), 0) AS cr
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = $1 AND l.cooperative_id = $2
         AND je.entry_date >= $3::date AND je.entry_date < $4::date
       GROUP BY month
       ORDER BY month`,
      [accountId, coopId, start, end],
    );

    const months = {};
    let interest = 0;
    monthly.rows.forEach((r) => {
      months[r.month] = { dr: parseFloat(r.dr), cr: parseFloat(r.cr) };
      interest += parseFloat(r.interest);
    });

    res.json({
      account: account.rows[0],
      year,
      ledger: buildLedger({
        title: account.rows[0].name,
        bfDr: net > 0 ? net : 0,
        bfCr: net < 0 ? -net : 0,
        months,
        interest,
      }),
    });
  } catch (err) {
    console.error("getAccountStatement failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ---------- A member's ledgers: one per savings / loan product ----------

const loadMemberBlocks = async (coopId, memberId, year) => {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;

  const [
    products,
    savingsBf,
    savingsMonthly,
    issuedBf,
    repaidBf,
    issuedMonthly,
    repaidMonthly,
  ] = await Promise.all([
    pool.query(
      "SELECT id, name, category FROM products WHERE cooperative_id = $1",
      [coopId],
    ),

    pool.query(
      `SELECT c.product_id,
                COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END), 0) AS net
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
           AND c.type IN ('savings', 'opening_balance', 'withdrawal') AND c.contribution_date < $3::date
         GROUP BY c.product_id`,
      [memberId, coopId, start],
    ),
    pool.query(
      `SELECT c.product_id, EXTRACT(MONTH FROM c.contribution_date)::int AS month,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type IN ('savings', 'opening_balance')), 0) AS cr,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type = 'withdrawal'), 0) AS dr
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
           AND c.contribution_date >= $3::date AND c.contribution_date < $4::date
         GROUP BY c.product_id, month`,
      [memberId, coopId, start, end],
    ),

    // Loans: what was owed (principal + one-off interest) before the year, less repayments before the year
    pool.query(
      `SELECT l.product_id, COALESCE(SUM(l.principal + l.interest_amount), 0) AS issued
         FROM loans l
         WHERE l.member_id = $1 AND l.cooperative_id = $2 AND l.date_issued < $3::date
         GROUP BY l.product_id`,
      [memberId, coopId, start],
    ),
    pool.query(
      `SELECT l.product_id, COALESCE(SUM(r.amount), 0) AS repaid
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
         WHERE l.member_id = $1 AND r.cooperative_id = $2 AND r.repayment_date < $3::date
         GROUP BY l.product_id`,
      [memberId, coopId, start],
    ),
    pool.query(
      `SELECT l.product_id, EXTRACT(MONTH FROM l.date_issued)::int AS month,
                COALESCE(SUM(l.principal), 0) AS dr, COALESCE(SUM(l.interest_amount), 0) AS interest
         FROM loans l
         WHERE l.member_id = $1 AND l.cooperative_id = $2
           AND l.date_issued >= $3::date AND l.date_issued < $4::date
         GROUP BY l.product_id, month`,
      [memberId, coopId, start, end],
    ),
    pool.query(
      `SELECT l.product_id, EXTRACT(MONTH FROM r.repayment_date)::int AS month,
                COALESCE(SUM(r.amount), 0) AS cr
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
         WHERE l.member_id = $1 AND r.cooperative_id = $2
           AND r.repayment_date >= $3::date AND r.repayment_date < $4::date
         GROUP BY l.product_id, month`,
      [memberId, coopId, start, end],
    ),
  ]);

  const product = {};
  products.rows.forEach((p) => {
    product[p.id] = p;
  });

  const blocks = [];

  // Savings products
  const savingsIds = new Set([
    ...savingsBf.rows.map((r) => r.product_id),
    ...savingsMonthly.rows.map((r) => r.product_id),
  ]);
  for (const id of savingsIds) {
    if (!product[id]) continue;
    const net = parseFloat(
      savingsBf.rows.find((r) => r.product_id === id)?.net || 0,
    );
    const months = {};
    savingsMonthly.rows
      .filter((r) => r.product_id === id)
      .forEach((r) => {
        months[r.month] = { dr: parseFloat(r.dr), cr: parseFloat(r.cr) };
      });

    if (Math.abs(net) < 0.005 && Object.keys(months).length === 0) continue;
    blocks.push({
      category: "savings",
      ...buildLedger({
        title: product[id].name,
        bfDr: net < 0 ? -net : 0,
        bfCr: net > 0 ? net : 0,
        months,
      }),
    });
  }

  // Loan products
  const loanIds = new Set([
    ...issuedBf.rows.map((r) => r.product_id),
    ...repaidBf.rows.map((r) => r.product_id),
    ...issuedMonthly.rows.map((r) => r.product_id),
    ...repaidMonthly.rows.map((r) => r.product_id),
  ]);
  for (const id of loanIds) {
    if (!product[id]) continue;
    const issued = parseFloat(
      issuedBf.rows.find((r) => r.product_id === id)?.issued || 0,
    );
    const repaid = parseFloat(
      repaidBf.rows.find((r) => r.product_id === id)?.repaid || 0,
    );
    const bf = issued - repaid;

    const months = {};
    let interest = 0;
    issuedMonthly.rows
      .filter((r) => r.product_id === id)
      .forEach((r) => {
        months[r.month] = {
          dr: parseFloat(r.dr),
          cr: months[r.month]?.cr || 0,
        };
        interest += parseFloat(r.interest);
      });
    repaidMonthly.rows
      .filter((r) => r.product_id === id)
      .forEach((r) => {
        months[r.month] = {
          dr: months[r.month]?.dr || 0,
          cr: parseFloat(r.cr),
        };
      });

    if (Math.abs(bf) < 0.005 && Object.keys(months).length === 0) continue;
    blocks.push({
      category: "loan",
      ...buildLedger({
        title: product[id].name,
        bfDr: bf > 0 ? bf : 0,
        bfCr: bf < 0 ? -bf : 0,
        months,
        interest,
      }),
    });
  }

  const order = { savings: 0, loan: 1 };
  blocks.sort(
    (a, b) =>
      order[a.category] - order[b.category] || a.title.localeCompare(b.title),
  );
  return blocks;
};

export const getMemberStatement = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const year = parseYear(req.query.year);

    const member = await pool.query(
      "SELECT id, full_name, member_number FROM members WHERE id = $1 AND cooperative_id = $2",
      [req.params.memberId, coopId],
    );
    if (member.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });

    const blocks = await loadMemberBlocks(coopId, member.rows[0].id, year);
    res.json({ member: member.rows[0], year, blocks });
  } catch (err) {
    console.error("getMemberStatement failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMyStatement = async (req, res) => {
  try {
    if (!req.user.memberId)
      return res
        .status(400)
        .json({ error: "This account isn't linked to a member" });
    const year = parseYear(req.query.year);
    const blocks = await loadMemberBlocks(
      req.user.cooperativeId,
      req.user.memberId,
      year,
    );
    res.json({ year, blocks });
  } catch (err) {
    console.error("getMyStatement failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
