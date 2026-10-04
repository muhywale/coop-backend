import pool from "../config/db.js";

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
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

export const getPaymentSchedule = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const periodType = req.query.period_type === "week" ? "week" : "month";
    const anchorDate = req.query.date || toLocalDateString(new Date());
    const [periodStart, periodEnd] =
      periodType === "week"
        ? getWeekRange(anchorDate)
        : getMonthRange(anchorDate);

    // Compulsory dues (savings / other products marked compulsory, matching this period's frequency)
    const duesProducts = await pool.query(
      `SELECT id, name, expected_amount FROM products
       WHERE cooperative_id = $1 AND active = true AND is_compulsory = true AND due_frequency = $2`,
      [coopId, periodType],
    );

    const members = await pool.query(
      `SELECT id, full_name, member_number FROM members WHERE cooperative_id = $1 AND status = 'active' ORDER BY full_name`,
      [coopId],
    );

    const duesRows = [];
    for (const product of duesProducts.rows) {
      const paidResult = await pool.query(
        `SELECT member_id, COALESCE(SUM(amount), 0) AS paid
         FROM contributions
         WHERE cooperative_id = $1 AND product_id = $2
           AND contribution_date BETWEEN $3 AND $4
           AND type IN ('savings', 'other')
         GROUP BY member_id`,
        [coopId, product.id, periodStart, periodEnd],
      );
      const paidMap = {};
      paidResult.rows.forEach((r) => {
        paidMap[r.member_id] = parseFloat(r.paid);
      });

      for (const m of members.rows) {
        const expected = parseFloat(product.expected_amount || 0);
        const paid = paidMap[m.id] || 0;
        let status;
        if (paid >= expected && expected > 0) status = "Paid";
        else if (paid > 0) status = "Partial";
        else status = new Date(periodEnd) < new Date() ? "Overdue" : "Pending";

        duesRows.push({
          member_id: m.id,
          full_name: m.full_name,
          member_number: m.member_number,
          product_name: product.name,
          expected_amount: expected,
          paid_amount: paid,
          status,
        });
      }
    }

    // Loan installments — loans whose repayment frequency (duration_unit) matches this period's type
    const unitMatch = periodType === "week" ? "weeks" : "months";
    const loans = await pool.query(
      `SELECT l.id, l.member_id, m.full_name, m.member_number, p.name AS product_name,
              l.principal, l.interest_amount, l.date_issued, l.duration_value, l.duration_unit,
              COALESCE(SUM(r.amount), 0) AS total_repaid
       FROM loans l
       JOIN members m ON l.member_id = m.id
       JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.cooperative_id = $1 AND l.status = 'active' AND l.duration_unit = $2 AND l.duration_value > 0
       GROUP BY l.id, m.full_name, m.member_number, p.name`,
      [coopId, unitMatch],
    );

    const paidThisPeriodResult = await pool.query(
      `SELECT r.loan_id, COALESCE(SUM(r.amount), 0) AS paid
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       WHERE l.cooperative_id = $1 AND r.repayment_date BETWEEN $2 AND $3
       GROUP BY r.loan_id`,
      [coopId, periodStart, periodEnd],
    );
    const paidThisPeriodMap = {};
    paidThisPeriodResult.rows.forEach((r) => {
      paidThisPeriodMap[r.loan_id] = parseFloat(r.paid);
    });

    const today = new Date();
    const loanRows = loans.rows.map((loan) => {
      const totalOwed =
        parseFloat(loan.principal) + parseFloat(loan.interest_amount || 0);
      const totalRepaid = parseFloat(loan.total_repaid);
      const installment = totalOwed / loan.duration_value;

      const issued = new Date(`${loan.date_issued}`);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysElapsed = Math.floor((today - issued) / msPerDay);
      const periodsElapsed =
        periodType === "week"
          ? Math.floor(daysElapsed / 7)
          : Math.floor(daysElapsed / 30);
      const expectedCumulative = Math.min(
        installment * Math.max(periodsElapsed, 0),
        totalOwed,
      );

      const paidThisPeriod = paidThisPeriodMap[loan.id] || 0;
      const outstanding = totalOwed - totalRepaid;

      let status;
      if (outstanding <= 0) status = "Completed";
      else if (paidThisPeriod >= installment * 0.8) status = "Performing well";
      else if (totalRepaid < expectedCumulative * 0.8)
        status = "Behind schedule";
      else status = "On track";

      return {
        loan_id: loan.id,
        member_id: loan.member_id,
        full_name: loan.full_name,
        member_number: loan.member_number,
        product_name: loan.product_name,
        installment,
        expected_this_period: Math.min(installment, Math.max(outstanding, 0)),
        paid_this_period: paidThisPeriod,
        outstanding,
        status,
      };
    });

    res.json({ periodStart, periodEnd, periodType, duesRows, loanRows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
