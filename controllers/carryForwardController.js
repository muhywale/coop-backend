import pool from "../config/db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

// ---------- Society-wide account balances ----------

export const getAccountCarryForward = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;

    const entries = await pool.query(
      `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
       FROM journal_entries
       WHERE source = 'opening_balance' AND cooperative_id = $1
       ORDER BY journal_entries.entry_date DESC, id DESC`,
      [coopId],
    );
    const entryIds = entries.rows.map((e) => e.id);

    const sums = entryIds.length
      ? await pool.query(
          `SELECT account_id, COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
           FROM journal_lines
           WHERE journal_entry_id = ANY($1::int[]) AND cooperative_id = $2
           GROUP BY account_id`,
          [entryIds, coopId],
        )
      : { rows: [] };

    const sumMap = {};
    sums.rows.forEach((r) => {
      sumMap[r.account_id] = {
        debit: parseFloat(r.debit),
        credit: parseFloat(r.credit),
      };
    });

    // Include deactivated accounts only if they already carry an opening figure
    const accounts = await pool.query(
      `SELECT id, code, name, account_type, normal_balance, active
       FROM chart_of_accounts
       WHERE cooperative_id = $1 AND (active = true OR id = ANY($2::int[]))
       ORDER BY code`,
      [coopId, Object.keys(sumMap).map(Number)],
    );

    res.json({
      asAt: entries.rows[0]?.entry_date || null,
      entryCount: entries.rows.length,
      accounts: accounts.rows.map((a) => ({
        ...a,
        debit: sumMap[a.id]?.debit || 0,
        credit: sumMap[a.id]?.credit || 0,
      })),
    });
  } catch (err) {
    console.error("getAccountCarryForward failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const saveAccountCarryForward = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const { as_at, lines } = req.body;

    if (!DATE_RE.test(as_at || ""))
      return res.status(400).json({ error: "Choose a valid 'as at' date" });
    if (!Array.isArray(lines))
      return res.status(400).json({ error: "lines must be an array" });

    const accountRows = await client.query(
      "SELECT id FROM chart_of_accounts WHERE cooperative_id = $1",
      [coopId],
    );
    const validIds = new Set(accountRows.rows.map((a) => a.id));

    const clean = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const l of lines) {
      const debit = cents(l.debit);
      const credit = cents(l.credit);
      if (debit < 0 || credit < 0)
        return res.status(400).json({ error: "Amounts cannot be negative" });
      if (debit === 0 && credit === 0) continue;
      if (!validIds.has(Number(l.account_id))) {
        return res
          .status(400)
          .json({
            error: "An account in the list does not belong to this cooperative",
          });
      }
      clean.push({ account_id: Number(l.account_id), debit, credit });
      totalDebit += debit;
      totalCredit += credit;
    }

    if (clean.length === 0)
      return res.status(400).json({ error: "Enter at least one balance" });
    if (Math.abs(totalDebit - totalCredit) >= 0.01) {
      return res.status(400).json({
        error: `Does not balance — debits ₦${totalDebit.toLocaleString()}, credits ₦${totalCredit.toLocaleString()}`,
      });
    }

    await client.query("BEGIN");

    // Single carry forward: replace whatever exists
    const old = await client.query(
      "SELECT id FROM journal_entries WHERE source = 'opening_balance' AND cooperative_id = $1",
      [coopId],
    );
    const oldIds = old.rows.map((r) => r.id);
    if (oldIds.length > 0) {
      await client.query(
        "DELETE FROM journal_lines WHERE journal_entry_id = ANY($1::int[]) AND cooperative_id = $2",
        [oldIds, coopId],
      );
      await client.query(
        "DELETE FROM journal_entries WHERE id = ANY($1::int[]) AND cooperative_id = $2",
        [oldIds, coopId],
      );
    }

    const entry = await client.query(
      `INSERT INTO journal_entries (entry_date, description, source, cooperative_id)
       VALUES ($1, 'Opening balances (carry forward)', 'opening_balance', $2) RETURNING id`,
      [as_at, coopId],
    );
    for (const l of clean) {
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, cooperative_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.rows[0].id, l.account_id, l.debit, l.credit, coopId],
      );
    }

    await client.query("COMMIT");
    res.json({
      message: `Account carry forward saved — ${clean.length} accounts, ₦${totalDebit.toLocaleString()} balanced`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveAccountCarryForward failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// ---------- Individual member balances ----------

export const getMemberCarryForward = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;

    const [members, products, contribs, loans] = await Promise.all([
      pool.query(
        "SELECT id, full_name, member_number FROM members WHERE cooperative_id = $1 ORDER BY full_name",
        [coopId],
      ),
      pool.query(
        `SELECT id, name, category, linked_account_id FROM products
         WHERE cooperative_id = $1 AND active = true AND category IN ('savings', 'loan')
         ORDER BY category, name`,
        [coopId],
      ),
      pool.query(
        `SELECT member_id, product_id, SUM(amount) AS amount,
                to_char(MAX(contribution_date), 'YYYY-MM-DD') AS d
         FROM contributions
         WHERE cooperative_id = $1 AND type = 'opening_balance' AND product_id IS NOT NULL
         GROUP BY member_id, product_id`,
        [coopId],
      ),
      pool.query(
        `SELECT member_id, product_id, SUM(principal) AS amount,
                to_char(MAX(date_issued), 'YYYY-MM-DD') AS d
         FROM loans
         WHERE cooperative_id = $1 AND is_opening = true AND product_id IS NOT NULL
         GROUP BY member_id, product_id`,
        [coopId],
      ),
    ]);

    const rows = [...contribs.rows, ...loans.rows];
    const dates = rows.map((r) => r.d).sort();

    res.json({
      asAt: dates.length ? dates[dates.length - 1] : null,
      members: members.rows,
      products: products.rows,
      cells: rows.map((r) => ({
        member_id: r.member_id,
        product_id: r.product_id,
        amount: parseFloat(r.amount),
      })),
    });
  } catch (err) {
    console.error("getMemberCarryForward failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

const saveSavingsCell = async (
  client,
  { coopId, memberId, productId, amount, asAt },
) => {
  const existing = await client.query(
    `SELECT id FROM contributions
     WHERE member_id = $1 AND product_id = $2 AND type = 'opening_balance' AND cooperative_id = $3
     ORDER BY id`,
    [memberId, productId, coopId],
  );
  const ids = existing.rows.map((r) => r.id);

  if (amount === 0) {
    if (ids.length) {
      await client.query(
        "DELETE FROM contributions WHERE id = ANY($1::int[]) AND cooperative_id = $2",
        [ids, coopId],
      );
    }
    return null;
  }
  if (ids.length === 0) {
    await client.query(
      `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
       VALUES ($1, $2, 'opening_balance', $3, 'Opening balance', $4, $5)`,
      [memberId, amount, asAt, productId, coopId],
    );
    return null;
  }
  await client.query(
    "UPDATE contributions SET amount = $1 WHERE id = $2 AND cooperative_id = $3",
    [amount, ids[0], coopId],
  );
  if (ids.length > 1) {
    await client.query(
      "DELETE FROM contributions WHERE id = ANY($1::int[]) AND cooperative_id = $2",
      [ids.slice(1), coopId],
    );
  }
  return null;
};

const saveLoanCell = async (
  client,
  { coopId, memberId, productId, amount, product, asAt },
) => {
  const existing = await client.query(
    `SELECT id, interest_amount FROM loans
     WHERE member_id = $1 AND product_id = $2 AND is_opening = true AND cooperative_id = $3
     ORDER BY id`,
    [memberId, productId, coopId],
  );

  if (existing.rows.length > 1) {
    return "More than one carried-forward loan exists for this product — correct it on the Loans page";
  }

  if (amount === 0) {
    if (existing.rows.length === 0) return null;
    const reps = await client.query(
      "SELECT COUNT(*)::int AS n FROM loan_repayments WHERE loan_id = $1 AND cooperative_id = $2",
      [existing.rows[0].id, coopId],
    );
    if (reps.rows[0].n > 0) {
      return "Repayments are already recorded against this loan — change the amount instead of removing it";
    }
    await client.query(
      "DELETE FROM loans WHERE id = $1 AND cooperative_id = $2",
      [existing.rows[0].id, coopId],
    );
    return null;
  }

  if (existing.rows.length === 0) {
    await client.query(
      `INSERT INTO loans (member_id, principal, interest_rate, date_issued, status, product_id, cooperative_id, is_opening)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, true)`,
      [memberId, amount, product.interest_rate || 0, asAt, productId, coopId],
    );
    return null;
  }

  // Edit in place, then re-check whether it is now fully repaid
  const loanId = existing.rows[0].id;
  const repaid = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS repaid FROM loan_repayments WHERE loan_id = $1 AND cooperative_id = $2",
    [loanId, coopId],
  );
  const owed = amount + parseFloat(existing.rows[0].interest_amount || 0);
  const status = parseFloat(repaid.rows[0].repaid) >= owed ? "paid" : "active";
  await client.query(
    "UPDATE loans SET principal = $1, status = $2 WHERE id = $3 AND cooperative_id = $4",
    [amount, status, loanId, coopId],
  );
  return null;
};

export const saveMemberCarryForward = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const { as_at, cells } = req.body;

    if (!DATE_RE.test(as_at || ""))
      return res.status(400).json({ error: "Choose a valid 'as at' date" });
    if (!Array.isArray(cells))
      return res.status(400).json({ error: "cells must be an array" });

    const [memberRows, productRows] = await Promise.all([
      client.query(
        "SELECT id, full_name FROM members WHERE cooperative_id = $1",
        [coopId],
      ),
      client.query(
        "SELECT id, name, category, interest_rate FROM products WHERE cooperative_id = $1",
        [coopId],
      ),
    ]);
    const memberMap = {};
    memberRows.rows.forEach((m) => {
      memberMap[m.id] = m.full_name;
    });
    const productMap = {};
    productRows.rows.forEach((p) => {
      productMap[p.id] = p;
    });

    let saved = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const cell of cells) {
      const memberId = Number(cell.member_id);
      const productId = Number(cell.product_id);
      const amount = cents(cell.amount);
      const product = productMap[productId];

      // member_id and product_id come from the browser — confirm they belong to this cooperative
      if (!memberMap[memberId] || !product) {
        skipped.push({
          cell: `member ${memberId} / product ${productId}`,
          reason: "Not found in this cooperative",
        });
        continue;
      }
      const label = `${memberMap[memberId]} — ${product.name}`;
      if (amount < 0) {
        skipped.push({ cell: label, reason: "Amount cannot be negative" });
        continue;
      }

      await client.query("SAVEPOINT cf_cell");
      try {
        const reason =
          product.category === "loan"
            ? await saveLoanCell(client, {
                coopId,
                memberId,
                productId,
                amount,
                product,
                asAt: as_at,
              })
            : await saveSavingsCell(client, {
                coopId,
                memberId,
                productId,
                amount,
                asAt: as_at,
              });
        if (reason) skipped.push({ cell: label, reason });
        else saved++;
        await client.query("RELEASE SAVEPOINT cf_cell");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT cf_cell");
        await client.query("RELEASE SAVEPOINT cf_cell");
        skipped.push({ cell: label, reason: err.message });
      }
    }

    // Keep the whole carry forward on one date
    await client.query(
      "UPDATE contributions SET contribution_date = $1 WHERE type = 'opening_balance' AND cooperative_id = $2",
      [as_at, coopId],
    );
    await client.query(
      "UPDATE loans SET date_issued = $1 WHERE is_opening = true AND cooperative_id = $2",
      [as_at, coopId],
    );

    await client.query("COMMIT");
    res.json({ message: `Saved ${saved} change(s)`, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveMemberCarryForward failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
