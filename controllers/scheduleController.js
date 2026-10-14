import pool from "../config/db.js";

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [toLocalDateString(monday), toLocalDateString(sunday)];
}

function getMonthRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [toLocalDateString(first), toLocalDateString(last)];
}

const round2 = (n) => Math.round(n * 100) / 100;

export const getPaymentSchedule = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const periodType = req.query.period_type === "week" ? "week" : "month";
    const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
      ? req.query.date
      : toLocalDateString(new Date());
    const [periodStart, periodEnd] =
      periodType === "week"
        ? getWeekRange(anchorDate)
        : getMonthRange(anchorDate);
    const periodEnded = periodEnd < toLocalDateString(new Date());

    const [duesProducts, members] = await Promise.all([
      pool.query(
        `SELECT id, name, expected_amount FROM products
         WHERE cooperative_id = $1 AND active = true AND is_compulsory = true AND due_frequency = $2
         ORDER BY name`,
        [coopId, periodType],
      ),
      pool.query(
        `SELECT id, full_name, member_number FROM members
         WHERE cooperative_id = $1 AND status = 'active' ORDER BY full_name`,
        [coopId],
      ),
    ]);

    const columns = duesProducts.rows.map((p) => ({
      key: `due_${p.id}`,
      label: p.name,
      kind: "due",
    }));
    const rowsByMember = {};
    members.rows.forEach((m) => {
      rowsByMember[m.id] = {
        member_id: m.id,
        member_number: m.member_number,
        full_name: m.full_name,
        items: {},
      };
    });

    // Compulsory dues
    if (duesProducts.rows.length > 0) {
      const paid = await pool.query(
        `SELECT member_id, product_id, COALESCE(SUM(amount), 0) AS paid
         FROM contributions
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[])
           AND contribution_date BETWEEN $3 AND $4 AND type IN ('savings', 'other')
         GROUP BY member_id, product_id`,
        [coopId, duesProducts.rows.map((p) => p.id), periodStart, periodEnd],
      );
      const paidMap = {};
      paid.rows.forEach((r) => {
        paidMap[`${r.member_id}-${r.product_id}`] = parseFloat(r.paid);
      });

      for (const m of members.rows) {
        for (const p of duesProducts.rows) {
          const expected = parseFloat(p.expected_amount || 0);
          if (expected <= 0) continue;
          rowsByMember[m.id].items[`due_${p.id}`] = {
            expected,
            paid: paidMap[`${m.id}-${p.id}`] || 0,
          };
        }
      }
    }

    // Loan installments: first installment falls in the first period after the loan is issued
    const loans = await pool.query(
      `SELECT l.id, l.member_id, l.product_id, p.name AS product_name,
              l.principal, l.interest_amount, l.duration_value,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date < $3), 0) AS repaid_before,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date BETWEEN $3 AND $4), 0) AS paid_in_period
       FROM loans l
       JOIN products p ON l.product_id = p.id
       WHERE l.cooperative_id = $1 AND l.duration_unit = $2 AND l.duration_value > 0
         AND l.date_issued < $3
       ORDER BY p.name`,
      [
        coopId,
        periodType === "week" ? "weeks" : "months",
        periodStart,
        periodEnd,
      ],
    );

    const loanColumns = new Map();
    for (const loan of loans.rows) {
      const row = rowsByMember[loan.member_id];
      if (!row) continue; // inactive member

      const totalOwed =
        parseFloat(loan.principal) + parseFloat(loan.interest_amount || 0);
      const outstandingAtStart = totalOwed - parseFloat(loan.repaid_before);
      if (outstandingAtStart <= 0.005) continue; // already cleared before this period

      const expected = Math.min(
        totalOwed / loan.duration_value,
        outstandingAtStart,
      );
      const key = `loan_${loan.product_id}`;
      if (!loanColumns.has(key))
        loanColumns.set(key, {
          key,
          label: `${loan.product_name} (loan)`,
          kind: "loan",
        });

      const item = row.items[key] || { expected: 0, paid: 0 };
      item.expected += expected;
      item.paid += parseFloat(loan.paid_in_period);
      row.items[key] = item;
    }
    columns.push(...loanColumns.values());

    const rows = Object.values(rowsByMember)
      .map((row) => {
        const items = Object.values(row.items);
        if (items.length === 0) return null;

        let totalExpected = 0;
        let totalPaid = 0;
        let balance = 0;
        let satisfied = 0;
        items.forEach((item) => {
          item.expected = round2(item.expected);
          item.paid = round2(item.paid);
          totalExpected += item.expected;
          totalPaid += item.paid;
          balance += Math.max(item.expected - item.paid, 0);
          if (item.paid >= item.expected - 0.005) satisfied++;
        });

        let status;
        if (satisfied === items.length) status = "Paid";
        else if (totalPaid > 0) status = "Partial";
        else status = periodEnded ? "Overdue" : "Pending";

        return {
          ...row,
          total_expected: round2(totalExpected),
          total_paid: round2(totalPaid),
          balance: round2(balance),
          status,
        };
      })
      .filter(Boolean);

    res.json({ periodStart, periodEnd, periodType, columns, rows });
  } catch (err) {
    console.error("getPaymentSchedule failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
