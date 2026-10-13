import pool from "../config/db.js";
import { postJournal, getDefaultCashAccount } from "../utils/journal.js";

const TITLES = new Set([
  "DR",
  "MR",
  "MRS",
  "MISS",
  "MS",
  "ALHAJI",
  "ALHAJA",
  "HAJIA",
  "CHIEF",
  "PROF",
  "PASTOR",
  "ENGR",
  "HON",
  "EVANG",
  "REV",
  "BARR",
  "MALLAM",
  "SIR",
  "MADAM",
  "DEACON",
  "DEACONESS",
  "ELDER",
  "OTUNBA",
  "PRINCE",
  "PRINCESS",
  "CAPT",
  "COL",
  "MAJ",
]);

// "Mrs. Oyewole H.O" -> ["OYEWOLE", "H", "O"]
const tokenize = (name) =>
  String(name || "")
    .toUpperCase()
    .replace(/[.,/\\()]/g, " ")
    .replace(/[^A-Z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !TITLES.has(t));

// Excel often drops the leading zero of account numbers, so pad back to 10 digits
const normalizeAccount = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length < 10 ? digits.padStart(10, "0") : digits;
};

// Shared surname/word(s) must match; the bank's other words must fit the app's initials
const scoreCandidate = (bankTokens, memberTokens) => {
  const anchors = new Set(
    bankTokens.filter((t) => t.length >= 3 && memberTokens.includes(t)),
  );
  if (anchors.size === 0) return null;

  const memberLetters = memberTokens
    .filter((t) => !anchors.has(t))
    .flatMap((t) => (t.length <= 3 ? t.split("") : [t[0]]));
  const bankInitials = bankTokens
    .filter((t) => !anchors.has(t))
    .map((t) => t[0]);

  let uncovered = 0;
  for (const initial of bankInitials) {
    const at = memberLetters.indexOf(initial);
    if (at >= 0) memberLetters.splice(at, 1);
    else uncovered++;
  }
  return { anchors: anchors.size, uncovered };
};

// POST /api/bank-import/match
export const matchBankList = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const { rows } = req.body;
    if (!Array.isArray(rows))
      return res.status(400).json({ error: "rows must be an array" });

    const [membersRes, aliasRes] = await Promise.all([
      pool.query(
        "SELECT id, full_name, member_number, bank_account_number FROM members WHERE cooperative_id = $1",
        [coopId],
      ),
      pool.query(
        "SELECT alias, member_id FROM member_aliases WHERE cooperative_id = $1",
        [coopId],
      ),
    ]);

    const members = membersRes.rows.map((m) => ({
      ...m,
      tokens: tokenize(m.full_name),
    }));
    const byId = {};
    const byAccount = {};
    members.forEach((m) => {
      byId[m.id] = m;
      if (m.bank_account_number)
        byAccount[normalizeAccount(m.bank_account_number)] = m;
    });
    const byAlias = {};
    aliasRes.rows.forEach((a) => {
      byAlias[a.alias] = a.member_id;
    });

    const view = (m) => ({
      id: m.id,
      full_name: m.full_name,
      member_number: m.member_number,
    });

    const results = rows.map((row) => {
      const base = {
        idx: row.idx,
        status: "none",
        member_id: null,
        candidates: [],
      };
      const bankTokens = tokenize(row.name);
      if (bankTokens.length === 0) return base;

      // 1. Account number — exact and authoritative
      const account = normalizeAccount(row.account_number);
      if (account && byAccount[account]) {
        const m = byAccount[account];
        return {
          ...base,
          status: "account",
          member_id: m.id,
          candidates: [view(m)],
        };
      }

      // 2. Saved alias from a previous confirmation
      const aliasMemberId = byAlias[bankTokens.join(" ")];
      if (aliasMemberId && byId[aliasMemberId]) {
        const m = byId[aliasMemberId];
        return {
          ...base,
          status: "alias",
          member_id: m.id,
          candidates: [view(m)],
        };
      }

      // 3. Same words in any order
      const sortedKey = [...bankTokens].sort().join(" ");
      const exact = members.filter(
        (m) => [...m.tokens].sort().join(" ") === sortedKey,
      );
      if (exact.length === 1) {
        return {
          ...base,
          status: "exact",
          member_id: exact[0].id,
          candidates: [view(exact[0])],
        };
      }
      if (exact.length > 1) {
        return {
          ...base,
          status: "ambiguous",
          candidates: exact.slice(0, 8).map(view),
        };
      }

      // 4. Surname + initials
      const scored = members
        .map((m) => ({ m, s: scoreCandidate(bankTokens, m.tokens) }))
        .filter((x) => x.s);
      const strong = scored.filter((x) => x.s.uncovered === 0);

      if (strong.length === 1) {
        return {
          ...base,
          status: "confident",
          member_id: strong[0].m.id,
          candidates: [view(strong[0].m)],
        };
      }

      const pool = (strong.length > 1 ? strong : scored)
        .sort(
          (a, b) => b.s.anchors - a.s.anchors || a.s.uncovered - b.s.uncovered,
        )
        .slice(0, 8);
      if (pool.length === 0) return base;
      return {
        ...base,
        status: "ambiguous",
        candidates: pool.map((x) => view(x.m)),
      };
    });

    res.json(results);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST /api/bank-import/loans
export const importBankLoans = async (req, res) => {
  const client = await pool.connect();
  try {
    const { loans, productId, durationValue, durationUnit } = req.body;
    const coopId = req.user.cooperativeId;

    if (!Array.isArray(loans) || loans.length === 0) {
      return res.status(400).json({ error: "No loans to import" });
    }
    if (!productId)
      return res.status(400).json({ error: "Select a loan product" });

    const productResult = await client.query(
      `SELECT id, name, interest_rate, interest_type, linked_account_id
       FROM products WHERE id = $1 AND cooperative_id = $2 AND category = 'loan'`,
      [productId, coopId],
    );
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Loan product not found" });
    }
    const product = productResult.rows[0];

    // member_id comes from the browser, so confirm every one really belongs to this cooperative
    const memberIds = [
      ...new Set(loans.map((l) => Number(l.member_id)).filter(Boolean)),
    ];
    const memberRows = await client.query(
      "SELECT id, full_name, bank_account_number FROM members WHERE id = ANY($1::int[]) AND cooperative_id = $2",
      [memberIds, coopId],
    );
    const memberMap = {};
    memberRows.rows.forEach((m) => {
      memberMap[m.id] = m;
    });

    const cashAccountId = await getDefaultCashAccount(client, coopId);
    const interestIncome = await client.query(
      "SELECT id FROM chart_of_accounts WHERE code = '4000' AND cooperative_id = $1",
      [coopId],
    );
    const interestAccountId = interestIncome.rows[0]?.id;

    let inserted = 0;
    const skipped = [];
    const warnings = [];

    await client.query("BEGIN");

    for (const loan of loans) {
      const label = loan.bank_name || `row ${loan.idx}`;
      const member = memberMap[Number(loan.member_id)];
      const amount = parseFloat(loan.amount);

      if (!member) {
        skipped.push({
          name: label,
          reason: "Member not found in this cooperative",
        });
        continue;
      }
      if (!amount || amount <= 0) {
        skipped.push({ name: label, reason: "Invalid amount" });
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(loan.date || "")) {
        skipped.push({ name: label, reason: "Missing or invalid date" });
        continue;
      }

      await client.query("SAVEPOINT bank_row");
      try {
        // Guard against importing the same list twice
        const dup = await client.query(
          `SELECT id FROM loans
           WHERE member_id = $1 AND product_id = $2 AND principal = $3 AND date_issued = $4 AND cooperative_id = $5`,
          [member.id, productId, amount, loan.date, coopId],
        );
        if (dup.rows.length > 0) {
          skipped.push({
            name: label,
            reason:
              "Looks like a duplicate (same member, product, amount and date)",
          });
          await client.query("RELEASE SAVEPOINT bank_row");
          continue;
        }

        const interestAmount =
          product.interest_type === "one_off"
            ? Math.round(
                ((amount * parseFloat(product.interest_rate || 0)) / 100) * 100,
              ) / 100
            : 0;

        const loanResult = await client.query(
          `INSERT INTO loans (member_id, principal, interest_rate, interest_amount, date_issued, status, product_id, cooperative_id, duration_value, duration_unit)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9) RETURNING id`,
          [
            member.id,
            amount,
            product.interest_rate,
            interestAmount,
            loan.date,
            productId,
            coopId,
            durationValue || null,
            durationUnit || "months",
          ],
        );
        const loanId = loanResult.rows[0].id;

        if (product.linked_account_id) {
          await postJournal(client, {
            entry_date: loan.date,
            description: `${product.name} issued — ${member.full_name} (bank list)`,
            source: "loan",
            source_id: loanId,
            cooperativeId: coopId,
            lines: [
              {
                account_id: product.linked_account_id,
                debit: amount,
                credit: 0,
              },
              { account_id: cashAccountId, debit: 0, credit: amount },
            ],
          });

          if (interestAmount > 0 && interestAccountId) {
            await postJournal(client, {
              entry_date: loan.date,
              description: `Loan interest (one-off) — loan #${loanId}`,
              source: "loan_interest",
              source_id: loanId,
              cooperativeId: coopId,
              lines: [
                {
                  account_id: product.linked_account_id,
                  debit: interestAmount,
                  credit: 0,
                },
                {
                  account_id: interestAccountId,
                  debit: 0,
                  credit: interestAmount,
                },
              ],
            });
          }
        }

        await client.query("RELEASE SAVEPOINT bank_row");
        inserted++;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT bank_row");
        skipped.push({ name: label, reason: err.message });
      }
    }

    // Remember every confirmed pairing so the next list matches automatically
    const savedAliases = new Set();
    const accountsClaimed = new Map();

    for (const loan of loans) {
      const member = memberMap[Number(loan.member_id)];
      if (!member) continue;

      await client.query("SAVEPOINT save_match");
      try {
        const key = tokenize(loan.bank_name).join(" ");
        if (key && !savedAliases.has(`${member.id}|${key}`)) {
          await client.query(
            `INSERT INTO member_aliases (member_id, alias, cooperative_id) VALUES ($1, $2, $3)
             ON CONFLICT (alias, cooperative_id) DO UPDATE SET member_id = EXCLUDED.member_id`,
            [member.id, key, coopId],
          );
          savedAliases.add(`${member.id}|${key}`);
        }

        const account = normalizeAccount(loan.account_number);
        if (account) {
          const stored = member.bank_account_number
            ? normalizeAccount(member.bank_account_number)
            : accountsClaimed.get(member.id);
          if (!stored) {
            await client.query(
              "UPDATE members SET bank_account_number = $1 WHERE id = $2 AND cooperative_id = $3",
              [account, member.id, coopId],
            );
            accountsClaimed.set(member.id, account);
          } else if (stored !== account) {
            warnings.push(
              `${member.full_name}: account ${account} differs from the saved ${stored} — left unchanged`,
            );
          }
        }
        await client.query("RELEASE SAVEPOINT save_match");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT save_match");
        warnings.push(
          err.code === "23505"
            ? `${loan.bank_name}: that account number is already saved on another member`
            : `Could not save match for ${loan.bank_name}: ${err.message}`,
        );
      }
    }

    await client.query("COMMIT");
    res.json({
      message: `Imported ${inserted} loan(s). Saved ${savedAliases.size} name match(es) and ${accountsClaimed.size} account number(s) for next time.`,
      skipped,
      warnings,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
