import pool from "../config/db.js";

const MONTH_NAMES = [
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
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) =>
  `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const parseYear = (value) => {
  const y = parseInt(value, 10);
  return y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
};

// ---------- Profile summary ----------

export const getSummary = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;

    const [member, coop, savings, loans] = await Promise.all([
      pool.query(
        "SELECT id, full_name, member_number, email, phone, status FROM members WHERE id = $1 AND cooperative_id = $2",
        [memberId, coopId],
      ),
      pool.query("SELECT name FROM cooperatives WHERE id = $1", [coopId]),
      pool.query(
        `SELECT p.id, p.name,
                COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END), 0) AS balance
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
           AND c.type IN ('savings', 'opening_balance', 'withdrawal')
         GROUP BY p.id, p.name
         ORDER BY p.name`,
        [memberId, coopId],
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE l.status = 'active')::int AS active_count,
                COALESCE(SUM((l.principal + l.interest_amount) - COALESCE(r.repaid, 0))
                         FILTER (WHERE l.status = 'active'), 0) AS outstanding
         FROM loans l
         LEFT JOIN (
           SELECT loan_id, SUM(amount) AS repaid FROM loan_repayments WHERE cooperative_id = $2 GROUP BY loan_id
         ) r ON r.loan_id = l.id
         WHERE l.member_id = $1 AND l.cooperative_id = $2`,
        [memberId, coopId],
      ),
    ]);

    if (member.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });

    const savingsList = savings.rows.map((r) => ({
      id: r.id,
      name: r.name,
      balance: round2(parseFloat(r.balance)),
    }));
    res.json({
      member: member.rows[0],
      cooperative: coop.rows[0]?.name || "",
      savings: savingsList,
      savings_total: round2(savingsList.reduce((s, r) => s + r.balance, 0)),
      loans: {
        active_count: loans.rows[0].active_count,
        outstanding: round2(parseFloat(loans.rows[0].outstanding)),
      },
    });
  } catch (err) {
    console.error("getSummary failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ---------- Loan details ----------

const interestNote = (l) => {
  if (l.interest_type === "one_off") {
    return parseFloat(l.interest_amount) > 0
      ? `Interest of ${money(l.interest_amount)} was added when the loan was issued.`
      : "Interest is included in the loan.";
  }
  if (l.interest_type === "reducing_balance") {
    return `${parseFloat(l.interest_rate || 0)}% per month on the balance, paid separately${
      l.interest_product_name ? ` through ${l.interest_product_name}` : ""
    }.`;
  }
  if (l.interest_type === "scheduled") {
    const parts = (l.interest_rules || []).map(
      (r) =>
        `${parseFloat(r.rate)}% of ${r.basis === "balance" ? "the balance" : "the loan amount"} ${
          r.months_after === 0
            ? "with your first payment"
            : `${r.months_after} months after your first payment`
        }`,
    );
    return parts.length
      ? `Interest, paid separately: ${parts.join("; ")}.`
      : null;
  }
  return null;
};

// When the last installment falls due
const endLabel = (l) => {
  if (!l.duration_value) return null;
  const offset = Number(l.first_offset);
  if (l.duration_unit === "months") {
    const [y, m] = l.date_issued.split("-").map(Number);
    const idx = y * 12 + (m - 1) + offset + l.duration_value - 1;
    return `${MONTH_NAMES[idx % 12]} ${Math.floor(idx / 12)}`;
  }
  const d = new Date(`${l.date_issued}T00:00:00`);
  d.setDate(d.getDate() + 7 * (offset + l.duration_value - 1));
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
};

export const getLoans = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;

    const [loanRows, repayRows] = await Promise.all([
      pool.query(
        `SELECT l.id, l.principal, l.interest_amount, l.status, l.duration_value, l.duration_unit, l.is_opening,
                to_char(l.date_issued, 'YYYY-MM-DD') AS date_issued,
                p.name AS product_name, p.interest_type, p.interest_rate, p.interest_rules,
                COALESCE(p.first_payment_offset, 1) AS first_offset,
                ip.name AS interest_product_name
         FROM loans l
         JOIN products p ON p.id = l.product_id
         LEFT JOIN products ip ON ip.id = p.interest_product_id
         WHERE l.member_id = $1 AND l.cooperative_id = $2
         ORDER BY (l.status = 'active') DESC, l.date_issued DESC, l.id DESC`,
        [memberId, coopId],
      ),
      pool.query(
        `SELECT r.loan_id, to_char(r.repayment_date, 'YYYY-MM-DD') AS date, r.amount
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
         WHERE l.member_id = $1 AND r.cooperative_id = $2
         ORDER BY r.repayment_date DESC, r.id DESC`,
        [memberId, coopId],
      ),
    ]);

    const repaysByLoan = {};
    repayRows.rows.forEach((r) => {
      if (!repaysByLoan[r.loan_id]) repaysByLoan[r.loan_id] = [];
      repaysByLoan[r.loan_id].push({
        date: r.date,
        amount: parseFloat(r.amount),
      });
    });

    const loans = loanRows.rows.map((l) => {
      const principal = parseFloat(l.principal);
      const interest = parseFloat(l.interest_amount || 0);
      const totalOwed = principal + interest;
      const repayments = repaysByLoan[l.id] || [];
      const repaid = repayments.reduce((s, r) => s + r.amount, 0);
      const outstanding = Math.max(totalOwed - repaid, 0);
      const installment =
        l.duration_value > 0 ? totalOwed / l.duration_value : null;

      return {
        id: l.id,
        product_name: l.product_name,
        status: l.status,
        is_opening: l.is_opening,
        date_issued: l.date_issued,
        principal: round2(principal),
        interest_added: round2(interest),
        total_owed: round2(totalOwed),
        repaid: round2(repaid),
        outstanding: round2(outstanding),
        progress_pct:
          totalOwed > 0
            ? Math.min(100, Math.round((repaid / totalOwed) * 100))
            : 0,
        duration_value: l.duration_value,
        duration_unit: l.duration_unit,
        installment: installment ? round2(installment) : null,
        periods_left:
          installment && outstanding > 0.005
            ? Math.ceil(outstanding / installment - 0.0001)
            : 0,
        finish_label: endLabel(l),
        interest_note: interestNote(l),
        repayments,
      };
    });

    res.json({ loans });
  } catch (err) {
    console.error("getLoans failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ---------- Statement of account ----------

const entry = (map, id, make) => {
  if (!map[id]) map[id] = make();
  return map[id];
};

export const getStatement = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const year = parseYear(req.query.year);
    const start = `${year}-01-01`;
    const end = `${year + 1}-01-01`;

    const [member, coop, products] = await Promise.all([
      pool.query(
        "SELECT full_name, member_number FROM members WHERE id = $1 AND cooperative_id = $2",
        [memberId, coopId],
      ),
      pool.query("SELECT name FROM cooperatives WHERE id = $1", [coopId]),
      pool.query("SELECT id, name FROM products WHERE cooperative_id = $1", [
        coopId,
      ]),
    ]);
    if (member.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });

    const pname = {};
    products.rows.forEach((p) => {
      pname[p.id] = p.name;
    });

    const [
      savingsBefore,
      savingsYear,
      issuedBefore,
      repaidBefore,
      issuedYear,
      repaidYear,
      contribTx,
      loanTx,
      repayTx,
    ] = await Promise.all([
      pool.query(
        `SELECT c.product_id, COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END), 0) AS net
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
           AND c.type IN ('savings', 'opening_balance', 'withdrawal') AND c.contribution_date < $3::date
         GROUP BY c.product_id`,
        [memberId, coopId, start],
      ),
      pool.query(
        `SELECT c.product_id,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type IN ('savings', 'opening_balance')), 0) AS paid_in,
                COALESCE(SUM(c.amount) FILTER (WHERE c.type = 'withdrawal'), 0) AS withdrawn
         FROM contributions c JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
           AND c.contribution_date >= $3::date AND c.contribution_date < $4::date
         GROUP BY c.product_id`,
        [memberId, coopId, start, end],
      ),
      pool.query(
        `SELECT l.product_id, COALESCE(SUM(l.principal + l.interest_amount), 0) AS issued
         FROM loans l WHERE l.member_id = $1 AND l.cooperative_id = $2 AND l.date_issued < $3::date
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
        `SELECT l.product_id, COALESCE(SUM(l.principal), 0) AS principal, COALESCE(SUM(l.interest_amount), 0) AS interest
         FROM loans l
         WHERE l.member_id = $1 AND l.cooperative_id = $2 AND l.date_issued >= $3::date AND l.date_issued < $4::date
         GROUP BY l.product_id`,
        [memberId, coopId, start, end],
      ),
      pool.query(
        `SELECT l.product_id, COALESCE(SUM(r.amount), 0) AS repaid
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
         WHERE l.member_id = $1 AND r.cooperative_id = $2
           AND r.repayment_date >= $3::date AND r.repayment_date < $4::date
         GROUP BY l.product_id`,
        [memberId, coopId, start, end],
      ),
      pool.query(
        `SELECT to_char(c.contribution_date, 'YYYY-MM-DD') AS date, c.type, c.amount, p.name AS product_name
         FROM contributions c LEFT JOIN products p ON p.id = c.product_id
         WHERE c.member_id = $1 AND c.cooperative_id = $2
           AND c.contribution_date >= $3::date AND c.contribution_date < $4::date
         ORDER BY c.contribution_date, c.id`,
        [memberId, coopId, start, end],
      ),
      pool.query(
        `SELECT to_char(l.date_issued, 'YYYY-MM-DD') AS date, l.principal, l.interest_amount, p.name AS product_name
         FROM loans l JOIN products p ON p.id = l.product_id
         WHERE l.member_id = $1 AND l.cooperative_id = $2 AND l.date_issued >= $3::date AND l.date_issued < $4::date
         ORDER BY l.date_issued, l.id`,
        [memberId, coopId, start, end],
      ),
      pool.query(
        `SELECT to_char(r.repayment_date, 'YYYY-MM-DD') AS date, r.amount, p.name AS product_name
         FROM loan_repayments r JOIN loans l ON l.id = r.loan_id JOIN products p ON p.id = l.product_id
         WHERE l.member_id = $1 AND r.cooperative_id = $2
           AND r.repayment_date >= $3::date AND r.repayment_date < $4::date
         ORDER BY r.repayment_date, r.id`,
        [memberId, coopId, start, end],
      ),
    ]);

    // Savings summary
    const sMap = {};
    const newSavings = (id) => () => ({
      product: pname[id] || `Product ${id}`,
      opening: 0,
      paid_in: 0,
      withdrawn: 0,
    });
    savingsBefore.rows.forEach((r) => {
      entry(sMap, r.product_id, newSavings(r.product_id)).opening = parseFloat(
        r.net,
      );
    });
    savingsYear.rows.forEach((r) => {
      const e = entry(sMap, r.product_id, newSavings(r.product_id));
      e.paid_in = parseFloat(r.paid_in);
      e.withdrawn = parseFloat(r.withdrawn);
    });
    const savings = Object.values(sMap)
      .map((e) => ({
        product: e.product,
        opening: round2(e.opening),
        paid_in: round2(e.paid_in),
        withdrawn: round2(e.withdrawn),
        closing: round2(e.opening + e.paid_in - e.withdrawn),
      }))
      .filter((e) => e.opening || e.paid_in || e.withdrawn || e.closing)
      .sort((a, b) => a.product.localeCompare(b.product));

    // Loan summary
    const lMap = {};
    const newLoan = (id) => () => ({
      product: pname[id] || `Product ${id}`,
      issued_before: 0,
      repaid_before: 0,
      principal: 0,
      interest: 0,
      repaid: 0,
    });
    issuedBefore.rows.forEach((r) => {
      entry(lMap, r.product_id, newLoan(r.product_id)).issued_before =
        parseFloat(r.issued);
    });
    repaidBefore.rows.forEach((r) => {
      entry(lMap, r.product_id, newLoan(r.product_id)).repaid_before =
        parseFloat(r.repaid);
    });
    issuedYear.rows.forEach((r) => {
      const e = entry(lMap, r.product_id, newLoan(r.product_id));
      e.principal = parseFloat(r.principal);
      e.interest = parseFloat(r.interest);
    });
    repaidYear.rows.forEach((r) => {
      entry(lMap, r.product_id, newLoan(r.product_id)).repaid = parseFloat(
        r.repaid,
      );
    });
    const loans = Object.values(lMap)
      .map((e) => {
        const opening = e.issued_before - e.repaid_before;
        return {
          product: e.product,
          opening: round2(opening),
          issued: round2(e.principal),
          interest: round2(e.interest),
          repaid: round2(e.repaid),
          closing: round2(opening + e.principal + e.interest - e.repaid),
        };
      })
      .filter(
        (e) => e.opening || e.issued || e.interest || e.repaid || e.closing,
      )
      .sort((a, b) => a.product.localeCompare(b.product));

    // Transactions, oldest first
    const transactions = [];
    contribTx.rows.forEach((c) => {
      const amount = parseFloat(c.amount);
      if (c.type === "withdrawal") {
        transactions.push({
          date: c.date,
          description: "Withdrawal",
          product: c.product_name || "",
          paid: 0,
          received: amount,
        });
      } else {
        const description =
          c.type === "opening_balance"
            ? "Balance brought forward"
            : c.type === "other"
              ? "Payment"
              : "Deposit";
        transactions.push({
          date: c.date,
          description,
          product: c.product_name || "",
          paid: amount,
          received: 0,
        });
      }
    });
    loanTx.rows.forEach((l) => {
      transactions.push({
        date: l.date,
        description: "Loan issued",
        product: l.product_name,
        paid: 0,
        received: parseFloat(l.principal),
      });
      if (parseFloat(l.interest_amount) > 0) {
        transactions.push({
          date: l.date,
          description: "Interest added to loan",
          product: l.product_name,
          paid: 0,
          received: parseFloat(l.interest_amount),
        });
      }
    });
    repayTx.rows.forEach((r) => {
      transactions.push({
        date: r.date,
        description: "Loan repayment",
        product: r.product_name,
        paid: parseFloat(r.amount),
        received: 0,
      });
    });
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      member: member.rows[0],
      cooperative: { name: coop.rows[0]?.name || "" },
      year,
      generated_at: new Date().toISOString(),
      savings,
      loans,
      transactions,
    });
  } catch (err) {
    console.error("getStatement failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
