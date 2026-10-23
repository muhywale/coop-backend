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

// "2026-11-05" -> a single number counting months, so month arithmetic is simple
const monthIndex = (dateStr) => {
  const [y, m] = dateStr.split("-").map(Number);
  return y * 12 + (m - 1);
};

export const getPaymentSchedule = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const periodType = req.query.period_type === "week" ? "week" : "month";
    // Products store "weekly" / "monthly"; the period selector uses "week" / "month"
    const frequency = periodType === "week" ? "weekly" : "monthly";
    const otherFrequency = frequency === "weekly" ? "monthly" : "weekly";

    const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
      ? req.query.date
      : toLocalDateString(new Date());
    const [periodStart, periodEnd] =
      periodType === "week"
        ? getWeekRange(anchorDate)
        : getMonthRange(anchorDate);
    const periodEnded = periodEnd < toLocalDateString(new Date());
    const warnings = [];

    const [duesProducts, members, otherFreqDues, noAmountDues] =
      await Promise.all([
        pool.query(
          `SELECT id, name, expected_amount FROM products
         WHERE cooperative_id = $1 AND active = true AND is_compulsory = true
           AND COALESCE(due_frequency, 'monthly') = $2 AND COALESCE(expected_amount, 0) > 0
         ORDER BY name`,
          [coopId, frequency],
        ),
        pool.query(
          `SELECT id, full_name, member_number FROM members
         WHERE cooperative_id = $1 AND status = 'active' ORDER BY full_name`,
          [coopId],
        ),
        pool.query(
          `SELECT name FROM products
         WHERE cooperative_id = $1 AND active = true AND is_compulsory = true
           AND COALESCE(due_frequency, 'monthly') <> $2 AND COALESCE(expected_amount, 0) > 0
         ORDER BY name`,
          [coopId, frequency],
        ),
        pool.query(
          `SELECT name FROM products
         WHERE cooperative_id = $1 AND active = true AND is_compulsory = true
           AND COALESCE(expected_amount, 0) <= 0
         ORDER BY name`,
          [coopId],
        ),
      ]);

    if (otherFreqDues.rows.length > 0) {
      warnings.push(
        `Set as ${otherFrequency} dues, so they show in the ${otherFrequency === "weekly" ? "Weekly" : "Monthly"} view instead: ${otherFreqDues.rows.map((r) => r.name).join(", ")}`,
      );
    }
    if (noAmountDues.rows.length > 0) {
      warnings.push(
        `Marked compulsory but with no amount set, so they can't be scheduled: ${noAmountDues.rows.map((r) => r.name).join(", ")}. Edit them on the Products page.`,
      );
    }

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

    // ---- Compulsory dues ----
    if (duesProducts.rows.length > 0) {
      const paid = await pool.query(
        `SELECT member_id, product_id, COALESCE(SUM(amount), 0) AS paid
         FROM contributions
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[])
           AND contribution_date BETWEEN $3::date AND $4::date AND type IN ('savings', 'other')
         GROUP BY member_id, product_id`,
        [coopId, duesProducts.rows.map((p) => p.id), periodStart, periodEnd],
      );
      const paidMap = {};
      paid.rows.forEach((r) => {
        paidMap[`${r.member_id}-${r.product_id}`] = parseFloat(r.paid);
      });

      for (const m of members.rows) {
        for (const p of duesProducts.rows) {
          rowsByMember[m.id].items[`due_${p.id}`] = {
            expected: parseFloat(p.expected_amount),
            paid: paidMap[`${m.id}-${p.id}`] || 0,
          };
        }
      }
    }

    // ---- Loan installments ----
    // "First payment is due" is a product setting: 0 = in the booking month, 1 = the month after
    const loans = await pool.query(
      `SELECT l.id, l.member_id, l.product_id, p.name AS product_name,
              l.principal, l.interest_amount, l.duration_value,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date < $3::date), 0) AS repaid_before,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date BETWEEN $3::date AND $4::date), 0) AS paid_in_period
       FROM loans l
       JOIN products p ON l.product_id = p.id
       WHERE l.cooperative_id = $1 AND l.duration_unit = $2 AND l.duration_value > 0
         AND (
           (COALESCE(p.first_payment_offset, 1) = 0 AND l.date_issued <= $4::date)
           OR (COALESCE(p.first_payment_offset, 1) = 1 AND l.date_issued < $3::date)
         )
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

    // ---- Interest due, collected through a separate payment line ----
    const interestColumns = new Map();
    const productsWithoutLine = new Set();

    const addInterestDue = (loan, due) => {
      if (due <= 0) return;
      if (!loan.interest_product_id) {
        productsWithoutLine.add(loan.product_name);
        return;
      }
      const row = rowsByMember[loan.member_id];
      if (!row) return;
      const key = `interest_${loan.interest_product_id}`;
      if (!interestColumns.has(key)) {
        interestColumns.set(key, {
          key,
          label: `${loan.interest_product_name} (interest due)`,
          kind: "interest",
          productId: loan.interest_product_id,
        });
      }
      const item = row.items[key] || { expected: 0, paid: 0 };
      item.expected += due;
      row.items[key] = item;
    };

    // (a) Reducing balance: a yearly rate on the principal still owed, every period
    const periodsPerYear = periodType === "week" ? 52 : 12;
    const reducing = await pool.query(
      `SELECT l.member_id, l.principal,
              COALESCE(l.interest_rate, p.interest_rate) AS rate,
              p.name AS product_name, p.interest_product_id, ip.name AS interest_product_name,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date < $2::date), 0) AS repaid_before
       FROM loans l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN products ip ON ip.id = p.interest_product_id
       WHERE l.cooperative_id = $1 AND p.interest_type = 'reducing_balance'
         AND l.date_issued < $2::date`,
      [coopId, periodStart],
    );
    for (const loan of reducing.rows) {
      const outstanding =
        parseFloat(loan.principal) - parseFloat(loan.repaid_before);
      const rate = parseFloat(loan.rate || 0);
      if (outstanding <= 0.005 || rate <= 0) continue;
      addInterestDue(loan, (outstanding * rate) / 100 / periodsPerYear);
    }

    // (b) Scheduled charges: one-off charges that fall in a particular month after the first payment
    const scheduled = await pool.query(
      `SELECT l.member_id, l.principal, to_char(l.date_issued, 'YYYY-MM-DD') AS issued_str,
              p.name AS product_name, p.interest_rules,
              COALESCE(p.first_payment_offset, 1) AS first_offset,
              p.interest_product_id, ip.name AS interest_product_name,
              COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                        WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id
                          AND r.repayment_date < $2::date), 0) AS repaid_before
       FROM loans l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN products ip ON ip.id = p.interest_product_id
       WHERE l.cooperative_id = $1 AND p.interest_type = 'scheduled'
         AND jsonb_array_length(COALESCE(p.interest_rules, '[]'::jsonb)) > 0
         AND l.date_issued <= $3::date`,
      [coopId, periodStart, periodEnd],
    );
    if (periodType === "month") {
      const periodIdx = monthIndex(periodStart);
      for (const loan of scheduled.rows) {
        const outstanding =
          parseFloat(loan.principal) - parseFloat(loan.repaid_before);
        if (outstanding <= 0.005) continue;
        const firstPaymentMonth =
          monthIndex(loan.issued_str) + Number(loan.first_offset);
        for (const rule of loan.interest_rules) {
          if (firstPaymentMonth + Number(rule.months_after) !== periodIdx)
            continue;
          const base =
            rule.basis === "balance" ? outstanding : parseFloat(loan.principal);
          addInterestDue(loan, (base * parseFloat(rule.rate)) / 100);
        }
      }
    } else if (scheduled.rows.length > 0) {
      warnings.push(
        "Scheduled interest charges fall in a particular month, so they appear in the Monthly view.",
      );
    }

    if (interestColumns.size > 0) {
      const paidInterest = await pool.query(
        `SELECT member_id, product_id, COALESCE(SUM(amount), 0) AS paid
         FROM contributions
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[])
           AND contribution_date BETWEEN $3::date AND $4::date AND type IN ('savings', 'other')
         GROUP BY member_id, product_id`,
        [
          coopId,
          [...interestColumns.values()].map((c) => c.productId),
          periodStart,
          periodEnd,
        ],
      );
      paidInterest.rows.forEach((r) => {
        const item =
          rowsByMember[r.member_id]?.items[`interest_${r.product_id}`];
        if (item) item.paid = parseFloat(r.paid);
      });
    }
    if (productsWithoutLine.size > 0) {
      warnings.push(
        `Interest can't be scheduled for these loans because no interest payment line is chosen: ${[...productsWithoutLine].join(", ")}. Edit the loan product on the Products page.`,
      );
    }
    columns.push(...interestColumns.values());

    // ---- One row per member ----
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

    res.json({ periodStart, periodEnd, periodType, columns, rows, warnings });
  } catch (err) {
    console.error("getPaymentSchedule failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
