import pool from "../config/db.js";
import { postJournal, getDefaultCashAccount } from "../utils/journal.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

// entries: [{ member_id, amounts: { [productId]: amount } }] — savings, fees and loan repayments in one map
export const recordBulkPayments = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    const { date, notes, entries } = req.body;

    if (!DATE_RE.test(date || ""))
      return res.status(400).json({ error: "Choose a valid date" });
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "No payments to record" });
    }

    const [productRows, memberRows] = await Promise.all([
      client.query(
        "SELECT id, name, category, linked_account_id FROM products WHERE cooperative_id = $1 AND active = true",
        [coopId],
      ),
      client.query(
        "SELECT id, full_name FROM members WHERE cooperative_id = $1",
        [coopId],
      ),
    ]);
    const productMap = {};
    productRows.rows.forEach((p) => {
      productMap[p.id] = p;
    });
    const memberMap = {};
    memberRows.rows.forEach((m) => {
      memberMap[m.id] = m.full_name;
    });

    // Check every product used in this batch before writing anything
    const referenced = new Set();
    entries.forEach((e) =>
      Object.entries(e.amounts || {}).forEach(([pid, amt]) => {
        if (cents(amt) > 0) referenced.add(Number(pid));
      }),
    );
    if (referenced.size === 0)
      return res.status(400).json({ error: "Enter at least one amount" });

    const unknown = [...referenced].filter((id) => !productMap[id]);
    if (unknown.length > 0)
      return res
        .status(400)
        .json({ error: "A product in the list was not found" });

    const unlinked = [...referenced].filter(
      (id) => !productMap[id].linked_account_id,
    );
    if (unlinked.length > 0) {
      return res.status(400).json({
        error: `Cannot record: these products are not linked to a ledger account yet — ${unlinked.map((id) => productMap[id].name).join(", ")}. Link them on the Products page first.`,
      });
    }

    const cashAccountId = await getDefaultCashAccount(client, coopId);

    let itemsSaved = 0;
    let totalSaved = 0;
    const savedMemberIds = [];
    const skipped = [];

    await client.query("BEGIN");

    for (const entry of entries) {
      const memberId = Number(entry.member_id);
      const memberName = memberMap[memberId];
      // member_id comes from the browser — confirm it belongs to this cooperative
      if (!memberName) {
        skipped.push({
          member: `member ${memberId}`,
          reason: "Not found in this cooperative",
        });
        continue;
      }

      const items = Object.entries(entry.amounts || {})
        .map(([pid, amt]) => ({ productId: Number(pid), amount: cents(amt) }))
        .filter((i) => i.amount > 0);
      if (items.length === 0) continue;

      // All of a member's items succeed together, or none of them do
      await client.query("SAVEPOINT member_entry");
      try {
        let memberItems = 0;
        let memberTotal = 0;

        for (const item of items) {
          const product = productMap[item.productId];

          if (product.category === "loan") {
            const loanResult = await client.query(
              `SELECT l.id,
                      (l.principal + l.interest_amount) - COALESCE(
                        (SELECT SUM(r.amount) FROM loan_repayments r
                         WHERE r.loan_id = l.id AND r.cooperative_id = l.cooperative_id), 0) AS outstanding
               FROM loans l
               WHERE l.member_id = $1 AND l.product_id = $2 AND l.status = 'active' AND l.cooperative_id = $3
               ORDER BY l.date_issued, l.id LIMIT 1`,
              [memberId, item.productId, coopId],
            );
            if (loanResult.rows.length === 0)
              throw new Error(`no active ${product.name} to repay`);

            const loan = loanResult.rows[0];
            const outstanding = parseFloat(loan.outstanding);
            if (item.amount > outstanding + 0.005) {
              throw new Error(
                `${product.name} repayment ₦${item.amount.toLocaleString()} is more than the ₦${outstanding.toLocaleString()} outstanding`,
              );
            }

            const repayment = await client.query(
              `INSERT INTO loan_repayments (loan_id, amount, repayment_date, cooperative_id)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [loan.id, item.amount, date, coopId],
            );
            await postJournal(client, {
              entry_date: date,
              description: `${product.name} repayment — ${memberName}`,
              source: "repayment",
              source_id: repayment.rows[0].id,
              cooperativeId: coopId,
              lines: [
                { account_id: cashAccountId, debit: item.amount, credit: 0 },
                {
                  account_id: product.linked_account_id,
                  debit: 0,
                  credit: item.amount,
                },
              ],
            });
            if (item.amount >= outstanding - 0.005) {
              await client.query(
                "UPDATE loans SET status = 'paid' WHERE id = $1 AND cooperative_id = $2",
                [loan.id, coopId],
              );
            }
          } else {
            const type = product.category === "other" ? "other" : "savings";
            const contribution = await client.query(
              `INSERT INTO contributions (member_id, amount, type, contribution_date, notes, product_id, cooperative_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [
                memberId,
                item.amount,
                type,
                date,
                notes || null,
                item.productId,
                coopId,
              ],
            );
            await postJournal(client, {
              entry_date: date,
              description: `${product.name} — ${memberName}`,
              source: "contribution",
              source_id: contribution.rows[0].id,
              cooperativeId: coopId,
              lines: [
                { account_id: cashAccountId, debit: item.amount, credit: 0 },
                {
                  account_id: product.linked_account_id,
                  debit: 0,
                  credit: item.amount,
                },
              ],
            });
          }

          memberItems++;
          memberTotal += item.amount;
        }

        await client.query("RELEASE SAVEPOINT member_entry");
        itemsSaved += memberItems;
        totalSaved += memberTotal;
        savedMemberIds.push(memberId);
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT member_entry");
        await client.query("RELEASE SAVEPOINT member_entry");
        skipped.push({ member: memberName, reason: err.message });
      }
    }

    await client.query("COMMIT");
    res.status(201).json({
      message: `Recorded ${itemsSaved} payment(s) for ${savedMemberIds.length} member(s), ₦${totalSaved.toLocaleString()} in total`,
      saved_member_ids: savedMemberIds,
      skipped,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("recordBulkPayments failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
