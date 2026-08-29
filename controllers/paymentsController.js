import { postJournal, getDefaultCashAccount } from "../utils/journal.js";
import pool from "../config/db.js";

export const distributePayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, date, loan_id, savings, other, loan_repayment, notes } =
      req.body;
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const allProductIds = [
      ...Object.keys(savings || {}),
      ...Object.keys(other || {}),
    ];
    if (allProductIds.length > 0) {
      const productsCheck = await client.query(
        `SELECT id, name, linked_account_id FROM products WHERE id = ANY($1::int[]) AND cooperative_id = $2`,
        [allProductIds.map(Number), coopId],
      );
      const unlinked = productsCheck.rows.filter((p) => !p.linked_account_id);
      if (unlinked.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Cannot record payment: the following products are not linked to a ledger account yet — ${unlinked.map((p) => p.name).join(", ")}. Link them in Chart of Accounts / Products settings first.`,
        });
      }
    }

    const cashAccountId = await getDefaultCashAccount(client, coopId);

    // Savings deposits
    if (savings && typeof savings === "object") {
      for (const [productId, amount] of Object.entries(savings)) {
        if (amount && parseFloat(amount) > 0) {
          const contributionResult = await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
             VALUES ($1, $2, 'savings', $3, $4, $5, $6) RETURNING id`,
            [member_id, amount, date, notes || null, productId, coopId],
          );
          const contributionId = contributionResult.rows[0].id;

          const product = await client.query(
            "SELECT linked_account_id, name FROM products WHERE id = $1 AND cooperative_id = $2",
            [productId, coopId],
          );
          const accountId = product.rows[0]?.linked_account_id;
          if (accountId) {
            await postJournal(client, {
              entry_date: date,
              description: `${product.rows[0].name} deposit — member ${member_id}`,
              source: "contribution",
              source_id: contributionId,
              cooperativeId: coopId,
              lines: [
                { account_id: cashAccountId, debit: amount, credit: 0 },
                { account_id: accountId, debit: 0, credit: amount },
              ],
            });
          }
        }
      }
    }

    // "Other" — fees, dues, fines
    if (other && typeof other === "object") {
      for (const [productId, amount] of Object.entries(other)) {
        if (amount && parseFloat(amount) > 0) {
          const contributionResult = await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
             VALUES ($1, $2, 'other', $3, $4, $5, $6) RETURNING id`,
            [member_id, amount, date, notes || null, productId, coopId],
          );
          const contributionId = contributionResult.rows[0].id;

          const product = await client.query(
            "SELECT linked_account_id, name FROM products WHERE id = $1 AND cooperative_id = $2",
            [productId, coopId],
          );
          const accountId = product.rows[0]?.linked_account_id;
          if (accountId) {
            await postJournal(client, {
              entry_date: date,
              description: `${product.rows[0].name} — member ${member_id}`,
              source: "contribution",
              source_id: contributionId,
              cooperativeId: coopId,
              lines: [
                { account_id: cashAccountId, debit: amount, credit: 0 },
                { account_id: accountId, debit: 0, credit: amount },
              ],
            });
          }
        }
      }
    }

    // Loan repayment
    if (loan_repayment && parseFloat(loan_repayment) > 0) {
      if (!loan_id)
        throw new Error(
          "Loan selected required when entering a loan repayment amount",
        );

      await client.query(
        `INSERT INTO loan_repayments (loan_id, amount, repayment_date, cooperative_id) VALUES ($1, $2, $3, $4)`,
        [loan_id, loan_repayment, date, coopId],
      );

      const loanRow = await client.query(
        `SELECT l.principal, l.product_id, COALESCE(SUM(r.amount), 0) AS total_repaid
         FROM loans l LEFT JOIN loan_repayments r ON r.loan_id = l.id
         WHERE l.id = $1 AND l.cooperative_id = $2 GROUP BY l.principal, l.product_id`,
        [loan_id, coopId],
      );
      const { principal, total_repaid, product_id } = loanRow.rows[0];
      if (parseFloat(total_repaid) >= parseFloat(principal)) {
        await client.query(
          `UPDATE loans SET status = 'paid' WHERE id = $1 AND cooperative_id = $2`,
          [loan_id, coopId],
        );
      }

      const product = await client.query(
        "SELECT linked_account_id FROM products WHERE id = $1 AND cooperative_id = $2",
        [product_id, coopId],
      );
      const loanAccountId = product.rows[0]?.linked_account_id;
      if (loanAccountId) {
        await postJournal(client, {
          entry_date: date,
          description: `Loan repayment — loan #${loan_id}`,
          source: "repayment",
          source_id: loan_id,
          cooperativeId: coopId,
          lines: [
            { account_id: cashAccountId, debit: loan_repayment, credit: 0 },
            { account_id: loanAccountId, debit: 0, credit: loan_repayment },
          ],
        });
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Payment distributed successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message || "Server error" });
  } finally {
    client.release();
  }
};

export const withdrawFunds = async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, product_id, amount, date, notes } = req.body;
    const coopId = req.user.cooperativeId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Enter a valid withdrawal amount" });
    }

    await client.query("BEGIN");

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('savings','opening_balance') THEN amount 
                                 WHEN type = 'withdrawal' THEN -amount ELSE 0 END), 0) AS balance
       FROM contributions WHERE member_id = $1 AND product_id = $2 AND cooperative_id = $3`,
      [member_id, product_id, coopId],
    );
    const currentBalance = parseFloat(balanceResult.rows[0].balance);

    if (parseFloat(amount) > currentBalance) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient balance. Available: ₦${currentBalance.toLocaleString()}`,
      });
    }

    const contributionResult = await client.query(
      `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
       VALUES ($1, $2, 'withdrawal', $3, $4, $5, $6) RETURNING id`,
      [member_id, amount, date, notes || null, product_id, coopId],
    );
    const contributionId = contributionResult.rows[0].id;

    const product = await client.query(
      "SELECT linked_account_id, name FROM products WHERE id = $1 AND cooperative_id = $2",
      [product_id, coopId],
    );
    const accountId = product.rows[0]?.linked_account_id;
    const cashAccountId = await getDefaultCashAccount(client, coopId);

    if (accountId) {
      await postJournal(client, {
        entry_date: date,
        description: `${product.rows[0].name} withdrawal — member ${member_id}`,
        source: "withdrawal",
        source_id: contributionId,
        cooperativeId: coopId,
        lines: [
          { account_id: accountId, debit: amount, credit: 0 },
          { account_id: cashAccountId, debit: 0, credit: amount },
        ],
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Withdrawal recorded successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message || "Server error" });
  } finally {
    client.release();
  }
};

export const correctContribution = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const contribution = await client.query(
      "SELECT * FROM contributions WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    if (contribution.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }

    const journalEntry = await client.query(
      `SELECT id FROM journal_entries WHERE source IN ('contribution','withdrawal') AND source_id = $1 AND cooperative_id = $2`,
      [id, coopId],
    );
    if (journalEntry.rows.length > 0) {
      const entryId = journalEntry.rows[0].id;
      const lines = await client.query(
        "SELECT * FROM journal_lines WHERE journal_entry_id = $1 AND cooperative_id = $2",
        [entryId, coopId],
      );

      const reversalResult = await client.query(
        `INSERT INTO journal_entries (entry_date, description, source, source_id, cooperative_id)
         VALUES (CURRENT_DATE, $1, 'reversal', $2, $3) RETURNING id`,
        [`Correction — reversing contribution #${id}`, entryId, coopId],
      );
      const reversalId = reversalResult.rows[0].id;

      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, cooperative_id) VALUES ($1, $2, $3, $4, $5)`,
          [reversalId, line.account_id, line.credit, line.debit, coopId],
        );
      }
    }

    await client.query(
      "DELETE FROM contributions WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );

    await client.query("COMMIT");
    res.json({
      message: "Transaction corrected — you can now re-enter it correctly.",
      original: contribution.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const bulkImportPayments = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, columnMap } = req.body;
    const coopId = req.user.cooperativeId;

    const members = await client.query(
      "SELECT id, full_name FROM members WHERE cooperative_id = $1",
      [coopId],
    );
    const memberMap = {};
    members.rows.forEach((m) => {
      memberMap[m.full_name.trim().toLowerCase()] = m.id;
    });

    const cashAccountId = await getDefaultCashAccount(client, coopId);
    const productsResult = await client.query(
      "SELECT id, linked_account_id, name, category FROM products WHERE cooperative_id = $1",
      [coopId],
    );
    const productMap = {};
    productsResult.rows.forEach((p) => {
      productMap[p.id] = p;
    });

    let inserted = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const row of rows) {
      const memberId = memberMap[row.member_name?.trim().toLowerCase()];
      if (!memberId) {
        skipped.push({ row: row.member_name, reason: "Member not found" });
        continue;
      }

      for (const [excelColumn, productId] of Object.entries(columnMap)) {
        const amount = parseFloat(row[excelColumn]);
        if (!amount || amount <= 0 || !productId) continue;

        const product = productMap[productId];
        if (!product) continue;

        const type = product.category === "other" ? "other" : "savings";

        const contributionResult = await client.query(
          `INSERT INTO contributions (member_id, amount, type, contribution_date, product_id, cooperative_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [memberId, amount, type, row.date, productId, coopId],
        );
        const contributionId = contributionResult.rows[0].id;

        if (product.linked_account_id) {
          await postJournal(client, {
            entry_date: row.date,
            description: `${product.name} — imported from Excel (${row.member_name})`,
            source: "contribution",
            source_id: contributionId,
            cooperativeId: coopId,
            lines: [
              { account_id: cashAccountId, debit: amount, credit: 0 },
              {
                account_id: product.linked_account_id,
                debit: 0,
                credit: amount,
              },
            ],
          });
        }
        inserted++;
      }
    }

    await client.query("COMMIT");
    res.json({ message: `Imported ${inserted} entries`, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const bulkImportLoanRepayments = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, loanRepColumn, productId } = req.body;
    const coopId = req.user.cooperativeId;

    const members = await client.query(
      "SELECT id, full_name FROM members WHERE cooperative_id = $1",
      [coopId],
    );
    const memberMap = {};
    members.rows.forEach((m) => {
      memberMap[m.full_name.trim().toLowerCase()] = m.id;
    });

    const cashAccountId = await getDefaultCashAccount(client, coopId);

    let inserted = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const row of rows) {
      const amount = parseFloat(row[loanRepColumn]);
      if (!amount || amount <= 0) continue;

      const memberId = memberMap[row.member_name?.trim().toLowerCase()];
      if (!memberId) {
        skipped.push({
          member: row.member_name,
          amount,
          reason: "Member not found",
        });
        continue;
      }

      const loanResult = await client.query(
        `SELECT l.id, p.linked_account_id, p.name
         FROM loans l JOIN products p ON l.product_id = p.id
         WHERE l.member_id = $1 AND l.product_id = $2 AND l.status = 'active' AND l.cooperative_id = $3
         ORDER BY l.date_issued DESC LIMIT 1`,
        [memberId, productId, coopId],
      );

      if (loanResult.rows.length === 0) {
        skipped.push({
          member: row.member_name,
          amount,
          reason: "No active loan of this product found",
        });
        continue;
      }

      const loan = loanResult.rows[0];

      await client.query(
        `INSERT INTO loan_repayments (loan_id, amount, repayment_date, cooperative_id) VALUES ($1, $2, $3, $4)`,
        [loan.id, amount, row.date, coopId],
      );

      if (loan.linked_account_id) {
        await postJournal(client, {
          entry_date: row.date,
          description: `${loan.name} repayment — ${row.member_name} (imported)`,
          source: "repayment",
          source_id: loan.id,
          cooperativeId: coopId,
          lines: [
            { account_id: cashAccountId, debit: amount, credit: 0 },
            { account_id: loan.linked_account_id, debit: 0, credit: amount },
          ],
        });
      }

      const totals = await client.query(
        `SELECT l.principal, COALESCE(SUM(r.amount), 0) AS total_repaid
         FROM loans l LEFT JOIN loan_repayments r ON r.loan_id = l.id
         WHERE l.id = $1 GROUP BY l.principal`,
        [loan.id],
      );
      if (
        parseFloat(totals.rows[0].total_repaid) >=
        parseFloat(totals.rows[0].principal)
      ) {
        await client.query(`UPDATE loans SET status = 'paid' WHERE id = $1`, [
          loan.id,
        ]);
      }

      inserted++;
    }

    await client.query("COMMIT");
    res.json({ message: `Imported ${inserted} loan repayments`, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const bulkImportLoans = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, productId } = req.body;
    const coopId = req.user.cooperativeId;

    const members = await client.query(
      "SELECT id, full_name FROM members WHERE cooperative_id = $1",
      [coopId],
    );
    const memberMap = {};
    members.rows.forEach((m) => {
      memberMap[m.full_name.trim().toLowerCase()] = m.id;
    });

    const product = await client.query(
      "SELECT id, name, interest_rate, linked_account_id FROM products WHERE id = $1 AND cooperative_id = $2",
      [productId, coopId],
    );
    if (product.rows.length === 0) {
      return res.status(404).json({ error: "Loan product not found" });
    }
    const {
      name: productName,
      interest_rate,
      linked_account_id,
    } = product.rows[0];

    const cashAccountId = await getDefaultCashAccount(client, coopId);

    let inserted = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const row of rows) {
      const amount = parseFloat(row.amount);
      if (!amount || amount <= 0) continue;

      const memberId = memberMap[row.member_name?.trim().toLowerCase()];
      if (!memberId) {
        skipped.push({
          member: row.member_name,
          amount,
          reason: "Member not found",
        });
        continue;
      }

      const loanResult = await client.query(
        `INSERT INTO loans (member_id, principal, interest_rate, date_issued, status, product_id, cooperative_id)
         VALUES ($1, $2, $3, $4, 'active', $5, $6) RETURNING id`,
        [memberId, amount, interest_rate, row.date, productId, coopId],
      );

      if (linked_account_id) {
        await postJournal(client, {
          entry_date: row.date,
          description: `${productName} issued — ${row.member_name} (imported)`,
          source: "loan",
          source_id: loanResult.rows[0].id,
          cooperativeId: coopId,
          lines: [
            { account_id: linked_account_id, debit: amount, credit: 0 },
            { account_id: cashAccountId, debit: 0, credit: amount },
          ],
        });
      }

      inserted++;
    }

    await client.query("COMMIT");
    res.json({ message: `Imported ${inserted} loans`, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const bulkImportOpeningBalances = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, columnMap, asAtDate } = req.body;
    const coopId = req.user.cooperativeId;

    const members = await client.query(
      "SELECT id, full_name FROM members WHERE cooperative_id = $1",
      [coopId],
    );
    const memberMap = {};
    members.rows.forEach((m) => {
      memberMap[m.full_name.trim().toLowerCase()] = m.id;
    });

    const productsResult = await client.query(
      "SELECT id, category, interest_rate, linked_account_id, name FROM products WHERE cooperative_id = $1",
      [coopId],
    );
    const productMap = {};
    productsResult.rows.forEach((p) => {
      productMap[p.id] = p;
    });

    let inserted = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const row of rows) {
      const memberId = memberMap[row.member_name?.trim().toLowerCase()];
      if (!memberId) {
        skipped.push({ row: row.member_name, reason: "Member not found" });
        continue;
      }

      for (const [excelColumn, productId] of Object.entries(columnMap)) {
        const amount = parseFloat(row[excelColumn]);
        if (!amount || amount <= 0 || !productId) continue;

        const product = productMap[productId];
        if (!product) continue;

        if (product.category === "loan") {
          const existing = await client.query(
            `SELECT id FROM loans WHERE member_id = $1 AND product_id = $2 AND date_issued = $3 AND cooperative_id = $4`,
            [memberId, productId, asAtDate, coopId],
          );
          if (existing.rows.length > 0) {
            skipped.push({
              member: row.member_name,
              column: excelColumn,
              reason: "Opening loan already exists",
            });
            continue;
          }

          await client.query(
            `INSERT INTO loans (member_id, principal, interest_rate, date_issued, status, product_id, cooperative_id)
             VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
            [
              memberId,
              amount,
              product.interest_rate || 0,
              asAtDate,
              productId,
              coopId,
            ],
          );
        } else {
          const existing = await client.query(
            `SELECT id FROM contributions WHERE member_id = $1 AND product_id = $2 AND type = 'opening_balance' AND cooperative_id = $3`,
            [memberId, productId, coopId],
          );
          if (existing.rows.length > 0) {
            skipped.push({
              member: row.member_name,
              column: excelColumn,
              reason: "Opening balance already exists",
            });
            continue;
          }

          await client.query(
            `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
             VALUES ($1, $2, 'opening_balance', $3, 'Opening balance import', $4, $5)`,
            [memberId, amount, asAtDate, productId, coopId],
          );
        }

        inserted++;
      }
    }

    await client.query("COMMIT");
    res.json({ message: `Imported ${inserted} opening balances`, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const bulkImportOpeningTrialBalance = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, codeColumn, debitColumn, creditColumn, asAtDate } = req.body;
    const coopId = req.user.cooperativeId;

    const accountsResult = await client.query(
      "SELECT id, code FROM chart_of_accounts WHERE cooperative_id = $1",
      [coopId],
    );
    const accountMap = {};
    accountsResult.rows.forEach((a) => {
      accountMap[a.code] = a.id;
    });

    const lines = [];
    const skipped = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const row of rows) {
      const code = String(row[codeColumn]).trim();
      const debit = parseFloat(row[debitColumn]) || 0;
      const credit = parseFloat(row[creditColumn]) || 0;
      if (debit === 0 && credit === 0) continue;

      const accountId = accountMap[code];
      if (!accountId) {
        skipped.push({
          code,
          debit,
          credit,
          reason: "Account code not found in Chart of Accounts",
        });
        continue;
      }

      if (debit > 0) {
        lines.push({ account_id: accountId, debit, credit: 0 });
        totalDebit += debit;
      }
      if (credit > 0) {
        lines.push({ account_id: accountId, debit: 0, credit });
        totalCredit += credit;
      }
    }

    if (Math.abs(totalDebit - totalCredit) > 1) {
      return res.status(400).json({
        error: `Does not balance — total debit ${totalDebit.toLocaleString()}, total credit ${totalCredit.toLocaleString()}. Check your source figures before importing.`,
        skipped,
      });
    }

    const existing = await client.query(
      `SELECT id FROM journal_entries WHERE source = 'opening_balance' AND entry_date = $1 AND cooperative_id = $2`,
      [asAtDate, coopId],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error:
          "An opening trial balance for this date already exists. Delete it first if you need to re-import.",
      });
    }

    await client.query("BEGIN");
    const entryResult = await client.query(
      `INSERT INTO journal_entries (entry_date, description, source, cooperative_id)
       VALUES ($1, 'Opening trial balance (imported)', 'opening_balance', $2) RETURNING id`,
      [asAtDate, coopId],
    );
    const entryId = entryResult.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, cooperative_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [entryId, line.account_id, line.debit, line.credit, coopId],
      );
    }

    await client.query("COMMIT");
    res.json({
      message: `Opening trial balance posted successfully — ${lines.length} lines, ₦${totalDebit.toLocaleString()} balanced`,
      skipped,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
export const bulkImportMembers = async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, nameColumn, memberNumberColumn } = req.body;
    const coopId = req.user.cooperativeId;

    let inserted = 0;
    let updated = 0;
    const skipped = [];

    await client.query("BEGIN");

    for (const row of rows) {
      const fullName = row[nameColumn]?.trim();
      const memberNumber = memberNumberColumn
        ? row[memberNumberColumn]?.toString().trim()
        : null;

      if (!fullName) {
        skipped.push({ row, reason: "Missing name" });
        continue;
      }

      // Check if this member already exists (by name) in this cooperative
      const existing = await client.query(
        `SELECT id, member_number FROM members WHERE full_name = $1 AND cooperative_id = $2`,
        [fullName, coopId],
      );

      if (existing.rows.length > 0) {
        // Already exists — update their member_number if we have one and they don't already
        if (memberNumber && !existing.rows[0].member_number) {
          await client.query(
            `UPDATE members SET member_number = $1 WHERE id = $2`,
            [memberNumber, existing.rows[0].id],
          );
          updated++;
        } else {
          skipped.push({ name: fullName, reason: "Member already exists" });
        }
        continue;
      }

      // New member — create with number if provided
      try {
        await client.query(
          `INSERT INTO members (full_name, member_number, cooperative_id) VALUES ($1, $2, $3)`,
          [fullName, memberNumber, coopId],
        );
        inserted++;
      } catch (err) {
        skipped.push({ name: fullName, reason: err.message });
      }
    }

    await client.query("COMMIT");
    res.json({
      message: `Imported ${inserted} new members, updated ${updated} existing`,
      skipped,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
