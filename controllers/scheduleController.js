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

// Whole days since 1970-01-01 for "YYYY-MM-DD", with no timezone drift
const dayNumber = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};
// Monday-based week number
const weekNumber = (dateStr) => Math.floor((dayNumber(dateStr) + 3) / 7);

const readParams = (query) => ({
  periodType: query.period_type === "week" ? "week" : "month",
  anchorDate: /^\d{4}-\d{2}-\d{2}$/.test(query.date || "")
    ? query.date
    : toLocalDateString(new Date()),
});

const buildCore = async (coopId, periodType, anchorDate) => {
  // Products store "weekly" / "monthly"; the period selector uses "week" / "month"
  const frequency = periodType === "week" ? "weekly" : "monthly";
  const otherFrequency = frequency === "weekly" ? "monthly" : "weekly";

  const [periodStart, periodEnd] =
    periodType === "week"
      ? getWeekRange(anchorDate)
      : getMonthRange(anchorDate);
  const periodEnded = periodEnd < toLocalDateString(new Date());
  const warnings = [];

  // Installments and interest are rounded the way this cooperative does it (e.g. to the nearest ₦1 or ₦10)
  const setting = await pool.query(
    "SELECT COALESCE(repayment_rounding, 1) AS step FROM cooperatives WHERE id = $1",
    [coopId],
  );
  const step = Math.max(1, parseInt(setting.rows[0]?.step, 10) || 1);
  const roundToStep = (n) => Math.round(n / step) * step;

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
  // ---- Compulsory dues (a member can have their own amount from a given month) ----
  if (duesProducts.rows.length > 0) {
    const productIds = duesProducts.rows.map((p) => p.id);
    const [paid, custom] = await Promise.all([
      pool.query(
        `SELECT member_id, product_id, COALESCE(SUM(amount), 0) AS paid
         FROM contributions
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[])
           AND contribution_date BETWEEN $3::date AND $4::date AND type IN ('savings', 'other')
         GROUP BY member_id, product_id`,
        [coopId, productIds, periodStart, periodEnd],
      ),
      // The latest personal amount that had started by the beginning of this period
      pool.query(
        `SELECT DISTINCT ON (member_id, product_id) member_id, product_id, amount
         FROM member_dues
         WHERE cooperative_id = $1 AND product_id = ANY($2::int[]) AND effective_from <= $3::date
         ORDER BY member_id, product_id, effective_from DESC`,
        [coopId, productIds, periodStart],
      ),
    ]);

    const paidMap = {};
    paid.rows.forEach((r) => {
      paidMap[`${r.member_id}-${r.product_id}`] = parseFloat(r.paid);
    });
    const customMap = {};
    custom.rows.forEach((r) => {
      customMap[`${r.member_id}-${r.product_id}`] = parseFloat(r.amount);
    });

    for (const m of members.rows) {
      for (const p of duesProducts.rows) {
        const own = customMap[`${m.id}-${p.id}`];
        const expected =
          own !== undefined ? own : parseFloat(p.expected_amount);
        if (expected <= 0) continue; // a member can be set to pay nothing
        rowsByMember[m.id].items[`due_${p.id}`] = {
          expected,
          paid: paidMap[`${m.id}-${p.id}`] || 0,
        };
      }
    }
  }

  // ---- Loan installments ----
  // "First payment is due" is a product setting: 0 = in the booking month, 1 = the month after
  // ---- Loan installments ----
  // "First payment is due" is a product setting: 0 = in the booking month, 1 = the month after
  const loans = await pool.query(
    `SELECT l.id, l.member_id, l.product_id, p.name AS product_name,
            l.principal, l.interest_amount, l.duration_value,
            to_char(l.date_issued, 'YYYY-MM-DD') AS issued_str,
            COALESCE(p.first_payment_offset, 1) AS first_offset,
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

    // Which installment this period is (0 = the first one)
    const installmentNo =
      periodType === "week"
        ? weekNumber(periodStart) -
          weekNumber(loan.issued_str) -
          Number(loan.first_offset)
        : monthIndex(periodStart) -
          (monthIndex(loan.issued_str) + Number(loan.first_offset));

    // Regular installments are rounded. The last one collects whatever is left,
    // so the loan clears exactly (and so does any arrears once the term is over).
    const isLast = installmentNo >= loan.duration_value - 1;
    const expected = isLast
      ? outstandingAtStart
      : Math.min(
          roundToStep(totalOwed / loan.duration_value),
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
    const amount = roundToStep(due);
    if (amount <= 0) return;
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
    item.expected += amount;
    row.items[key] = item;
  };

  // (a) Reducing balance: the rate is a MONTHLY rate on the principal still owed,
  //     so it is a monthly event and shows in the Monthly view only
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
  if (periodType === "month") {
    for (const loan of reducing.rows) {
      const outstanding =
        parseFloat(loan.principal) - parseFloat(loan.repaid_before);
      const rate = parseFloat(loan.rate || 0);
      if (outstanding <= 0.005 || rate <= 0) continue;
      addInterestDue(loan, (outstanding * rate) / 100);
    }
  } else if (reducing.rows.length > 0) {
    warnings.push(
      "Reducing-balance interest is charged monthly, so it appears in the Monthly view.",
    );
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
      const item = rowsByMember[r.member_id]?.items[`interest_${r.product_id}`];
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

  return { periodStart, periodEnd, periodType, columns, rows, warnings };
};

// ---- Fines ----
// A fine for the period that has just ended is added to the amounts due in this period,
// and is collected through the cooperative's Fines payment line (income when received).

const dayBefore = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
};

const finalizeRow = (row, periodEnded) => {
  const items = Object.values(row.items);
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
};

const addFines = async (coopId, periodType, schedule) => {
  const setting = await pool.query(
    `SELECT r.fine_product_id, to_char(r.fines_start, 'YYYY-MM-DD') AS fines_start,
            COALESCE(c.repayment_rounding, 1) AS step
     FROM cooperatives c LEFT JOIN cooperative_rules r ON r.cooperative_id = c.id
     WHERE c.id = $1`,
    [coopId],
  );
  const {
    fine_product_id: fineProductId,
    fines_start: finesStart,
    step,
  } = setting.rows[0] || {};
  if (!fineProductId || !finesStart) return;

  const ruleRows = await pool.query(
    `SELECT member_group, fixed_amount, fixed_when, percent, base
     FROM fine_rules WHERE cooperative_id = $1 AND period_type = $2 AND enabled = true`,
    [coopId, periodType],
  );
  if (ruleRows.rows.length === 0) return;
  const rules = {};
  ruleRows.rows.forEach((r) => {
    rules[r.member_group] = {
      fixed: parseFloat(r.fixed_amount),
      fixedWhen: r.fixed_when,
      percent: parseFloat(r.percent),
      base: r.base,
    };
  });

  // The period that has just ended; periods before the start month are never fined
  const previous = await buildCore(
    coopId,
    periodType,
    dayBefore(schedule.periodStart),
  );
  if (previous.periodStart < finesStart) return;

  const roundStep = Math.max(1, parseInt(step, 10) || 1);
  const kindOf = {};
  previous.columns.forEach((c) => {
    kindOf[c.key] = c.kind;
  });
  const counts = {
    all: () => true,
    savings: (key) => kindOf[key] === "due",
    loan: (key) => kindOf[key] === "loan" || kindOf[key] === "interest",
  };

  const fines = {};
  for (const row of previous.rows) {
    const entries = Object.entries(row.items);
    const onLoan = entries.some(([key]) => kindOf[key] === "loan");
    const rule = rules[onLoan ? "on_loan" : "no_loan"];
    if (!rule) continue;

    const counted = entries.filter(([key]) => counts[rule.base](key));
    if (counted.length === 0) continue;
    const shortfall = counted.reduce(
      (sum, [, item]) => sum + Math.max(item.expected - item.paid, 0),
      0,
    );
    if (shortfall <= 0.005) continue;

    const paidNothing = counted.every(([, item]) => item.paid <= 0.005);
    let fine = 0;
    if (rule.fixed > 0 && (rule.fixedWhen === "any_shortfall" || paidNothing))
      fine += rule.fixed;
    if (rule.percent > 0) fine += (shortfall * rule.percent) / 100;
    fine = Math.round(fine / roundStep) * roundStep;
    if (fine > 0) fines[row.member_id] = { amount: fine, row };
  }

  const memberIds = Object.keys(fines).map(Number);
  if (memberIds.length === 0) return;

  const paid = await pool.query(
    `SELECT member_id, COALESCE(SUM(amount), 0) AS paid FROM contributions
     WHERE cooperative_id = $1 AND product_id = $2
       AND contribution_date BETWEEN $3::date AND $4::date AND type IN ('savings', 'other')
     GROUP BY member_id`,
    [coopId, fineProductId, schedule.periodStart, schedule.periodEnd],
  );
  const paidMap = {};
  paid.rows.forEach((r) => {
    paidMap[r.member_id] = parseFloat(r.paid);
  });

  // Uses the "due_<product id>" key so Fill expected on Record Payment puts the fine in the Fines line
  const key = `due_${fineProductId}`;
  const periodEnded = schedule.periodEnd < toLocalDateString(new Date());
  const byMember = new Map(schedule.rows.map((r) => [r.member_id, r]));

  for (const id of memberIds) {
    const { amount, row: previousRow } = fines[id];
    const existing = byMember.get(id) || {
      member_id: id,
      member_number: previousRow.member_number,
      full_name: previousRow.full_name,
      items: {},
    };
    existing.items = {
      ...existing.items,
      [key]: { expected: amount, paid: paidMap[id] || 0 },
    };
    byMember.set(id, finalizeRow(existing, periodEnded));
  }

  schedule.rows = [...byMember.values()].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );
  if (!schedule.columns.some((c) => c.key === key)) {
    schedule.columns.push({
      key,
      label: `Fines (last ${periodType})`,
      kind: "due",
    });
  }
};

// ---- Loan form amount ----
// An expected payment: due in the period the loan is issued, and carried forward until the member pays it
// (through Record Payment, into the Loan Form payment line, where it becomes income).
const addFormFees = async (coopId, schedule) => {
  const setting = await pool.query(
    "SELECT form_fee_product_id FROM cooperative_rules WHERE cooperative_id = $1",
    [coopId],
  );
  const productId = setting.rows[0]?.form_fee_product_id;
  if (!productId) return;

  const { periodStart, periodEnd } = schedule;

  const dues = await pool.query(
    `SELECT member_id,
            COALESCE(SUM(form_fee_due) FILTER (WHERE date_issued < $2::date), 0) AS before_due,
            COALESCE(SUM(form_fee_due) FILTER (WHERE date_issued >= $2::date), 0) AS new_due
     FROM loans
     WHERE cooperative_id = $1 AND form_fee_due > 0 AND date_issued <= $3::date
     GROUP BY member_id`,
    [coopId, periodStart, periodEnd],
  );
  if (dues.rows.length === 0) return;

  const ids = dues.rows.map((d) => d.member_id);
  const [payments, members] = await Promise.all([
    pool.query(
      `SELECT member_id,
              COALESCE(SUM(amount) FILTER (WHERE contribution_date < $3::date), 0) AS paid_before,
              COALESCE(SUM(amount) FILTER (WHERE contribution_date >= $3::date), 0) AS paid_now
       FROM contributions
       WHERE cooperative_id = $1 AND product_id = $2 AND type IN ('savings', 'other')
         AND contribution_date <= $4::date AND member_id = ANY($5::int[])
       GROUP BY member_id`,
      [coopId, productId, periodStart, periodEnd, ids],
    ),
    pool.query(
      "SELECT id, full_name, member_number FROM members WHERE cooperative_id = $1 AND status = 'active' AND id = ANY($2::int[])",
      [coopId, ids],
    ),
  ]);

  const paidMap = {};
  payments.rows.forEach((r) => {
    paidMap[r.member_id] = {
      before: parseFloat(r.paid_before),
      now: parseFloat(r.paid_now),
    };
  });
  const memberMap = {};
  members.rows.forEach((m) => {
    memberMap[m.id] = m;
  });

  // Uses the "due_<product id>" key so Fill expected on Record Payment puts it in the Loan Form line
  const key = `due_${productId}`;
  const periodEnded = periodEnd < toLocalDateString(new Date());
  const byMember = new Map(schedule.rows.map((r) => [r.member_id, r]));
  let added = false;

  for (const d of dues.rows) {
    const member = memberMap[d.member_id];
    if (!member) continue; // inactive members aren't scheduled
    const paid = paidMap[d.member_id] || { before: 0, now: 0 };

    // Anything still unpaid from earlier months, plus what falls due in this period
    const carried = Math.max(parseFloat(d.before_due) - paid.before, 0);
    const expected = round2(carried + parseFloat(d.new_due));
    if (expected <= 0.005) continue;

    const row = byMember.get(d.member_id) || {
      member_id: member.id,
      member_number: member.member_number,
      full_name: member.full_name,
      items: {},
    };
    const existing = row.items[key];
    row.items = {
      ...row.items,
      [key]: {
        expected: (existing ? existing.expected : 0) + expected,
        paid: existing ? existing.paid : paid.now,
      },
    };
    byMember.set(d.member_id, finalizeRow(row, periodEnded));
    added = true;
  }

  if (!added) return;
  schedule.rows = [...byMember.values()].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );
  if (!schedule.columns.some((c) => c.key === key)) {
    schedule.columns.push({ key, label: "Loan form", kind: "due" });
  }
};

export const buildSchedule = async (coopId, periodType, anchorDate) => {
  const schedule = await buildCore(coopId, periodType, anchorDate);

  const extras = [
    ["Fines", () => addFines(coopId, periodType, schedule)],
    ["The loan form amount", () => addFormFees(coopId, schedule)],
  ];
  for (const [name, run] of extras) {
    try {
      await run();
    } catch (err) {
      // The schedule itself must keep working, even if the new tables or columns aren't set up yet
      if (err.code !== "42P01" && err.code !== "42703") {
        console.error(`${name} failed:`, err);
        schedule.warnings.push(`${name} couldn't be worked out right now.`);
      }
    }
  }
  return schedule;
};
// Admin: the whole cooperative
export const getPaymentSchedule = async (req, res) => {
  try {
    const { periodType, anchorDate } = readParams(req.query);
    res.json(
      await buildSchedule(req.user.cooperativeId, periodType, anchorDate),
    );
  } catch (err) {
    console.error("getPaymentSchedule failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Member: only their own row, never anyone else's
export const getMySchedule = async (req, res) => {
  try {
    if (!req.user.memberId)
      return res
        .status(400)
        .json({ error: "This account isn't linked to a member" });

    const { periodType, anchorDate } = readParams(req.query);
    const data = await buildSchedule(
      req.user.cooperativeId,
      periodType,
      anchorDate,
    );

    const row =
      data.rows.find((r) => r.member_id === req.user.memberId) || null;
    res.json({
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      periodType: data.periodType,
      columns: row ? data.columns.filter((c) => row.items[c.key]) : [],
      row,
    });
  } catch (err) {
    console.error("getMySchedule failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
