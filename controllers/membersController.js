import pool from "../config/db.js";

// GET all members
export const getMembers = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM members WHERE cooperative_id = $1 ORDER BY id",
      [req.user.cooperativeId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// GET single member
export const getMemberById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND cooperative_id = $2",
      [id, req.user.cooperativeId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// POST create new member
export const createMember = async (req, res) => {
  try {
    const { full_name, email, phone, member_number } = req.body;
    const result = await pool.query(
      "INSERT INTO members (full_name, email, phone, member_number, cooperative_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [full_name, email, phone, member_number || null, req.user.cooperativeId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    if (err.code === "23505") {
      return res.status(409).json({
        error: `Member number "${req.body.member_number}" already exists in this cooperative`,
      });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// PUT update member
export const updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, member_number, status } = req.body;
    const result = await pool.query(
      "UPDATE members SET full_name=$1, email=$2, phone=$3, status=$4, member_number=$5 WHERE id=$6 AND cooperative_id=$7 RETURNING *",
      [
        full_name,
        email,
        phone,
        member_number,
        status,
        id,
        req.user.cooperativeId,
      ],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE member
export const deleteMember = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "DELETE FROM members WHERE id = $1 AND cooperative_id = $2",
      [id, req.user.cooperativeId],
    );
    res.json({ message: "Member deleted" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMemberDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;

    const memberResult = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND cooperative_id = $2",
      [id, coopId],
    );
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const balanceResult = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('savings','opening_balance') THEN amount 
                                 WHEN type = 'withdrawal' THEN -amount 
                                 ELSE 0 END), 0) AS balance
       FROM contributions WHERE member_id = $1 AND cooperative_id = $2`,
      [id, coopId],
    );

    const contributionsResult = await pool.query(
      `SELECT * FROM contributions WHERE member_id = $1 AND cooperative_id = $2 ORDER BY contribution_date DESC`,
      [id, coopId],
    );

    const loansResult = await pool.query(
      `SELECT l.*, l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2
       GROUP BY l.id
       ORDER BY l.date_issued DESC`,
      [id, coopId],
    );

    res.json({
      member: memberResult.rows[0],
      savingsBalance: balanceResult.rows[0].balance,
      contributions: contributionsResult.rows,
      loans: loansResult.rows,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMyDetail = async (req, res) => {
  req.params.id = req.user.memberId;
  return getMemberDetail(req, res);
};

export const getMemberTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;

    const result = await pool.query(
      `SELECT 
         id, 'contribution' AS source, type, amount, contribution_date AS date, notes
       FROM contributions
       WHERE member_id = $1 AND cooperative_id = $2

       UNION ALL

       SELECT 
         id, 'loan_issued' AS source, 'loan' AS type, principal AS amount, date_issued AS date, 
         'Loan issued' AS notes
       FROM loans
       WHERE member_id = $1 AND cooperative_id = $2

       UNION ALL

       SELECT 
         r.id, 'loan_repayment' AS source, 'loan_repayment' AS type, r.amount, r.repayment_date AS date,
         'Repayment on loan #' || r.loan_id AS notes
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2

       ORDER BY date DESC`,
      [id, coopId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMyTransactions = async (req, res) => {
  req.params.id = req.user.memberId;
  return getMemberTransactions(req, res);
};

export const getMemberLedgerByProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;

    const savings = await pool.query(
      `SELECT c.id, p.name AS product_name, c.type, c.amount, c.contribution_date AS date, c.notes
       FROM contributions c
       JOIN products p ON c.product_id = p.id
       WHERE c.member_id = $1 AND c.cooperative_id = $2
       ORDER BY p.name, c.contribution_date`,
      [id, coopId],
    );

    const loans = await pool.query(
      `SELECT l.id, p.name AS product_name, l.principal, l.interest_rate, l.date_issued, l.status,
              l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2
       GROUP BY l.id, p.name
       ORDER BY p.name, l.date_issued`,
      [id, coopId],
    );

    const savingsByProduct = {};
    savings.rows.forEach((row) => {
      if (!savingsByProduct[row.product_name])
        savingsByProduct[row.product_name] = [];
      savingsByProduct[row.product_name].push(row);
    });

    const loansByProduct = {};
    loans.rows.forEach((row) => {
      if (!loansByProduct[row.product_name])
        loansByProduct[row.product_name] = [];
      loansByProduct[row.product_name].push(row);
    });

    res.json({ savingsByProduct, loansByProduct });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMyLedger = async (req, res) => {
  req.params.id = req.user.memberId;
  return getMemberLedgerByProduct(req, res);
};

export const getMemberAccountsLedger = async (req, res) => {
  try {
    const { id } = req.params;
    const coopId = req.user.cooperativeId;
    const { groupBy = "month", year } = req.query;

    const truncUnit =
      groupBy === "day" ? "day" : groupBy === "week" ? "week" : "month";

    const savingsResult = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              date_trunc($3, c.contribution_date) AS period,
              COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN c.amount ELSE 0 END), 0) AS dr,
              COALESCE(SUM(CASE WHEN c.type IN ('savings','opening_balance') THEN c.amount ELSE 0 END), 0) AS cr
       FROM contributions c
       JOIN products p ON c.product_id = p.id
       WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
         AND EXTRACT(YEAR FROM c.contribution_date) = $4
       GROUP BY p.id, p.name, period
       ORDER BY p.name, period`,
      [id, coopId, truncUnit, year],
    );

    const bfResult = await pool.query(
      `SELECT p.id AS product_id,
              COALESCE(SUM(CASE WHEN c.type = 'withdrawal' THEN -c.amount ELSE c.amount END), 0) AS bf
       FROM contributions c
       JOIN products p ON c.product_id = p.id
       WHERE c.member_id = $1 AND c.cooperative_id = $2 AND p.category = 'savings'
         AND c.contribution_date < ($3 || '-01-01')::date
       GROUP BY p.id`,
      [id, coopId, year],
    );
    const bfMap = {};
    bfResult.rows.forEach((r) => {
      bfMap[r.product_id] = parseFloat(r.bf);
    });

    const loanDrResult = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              date_trunc($3, l.date_issued) AS period,
              COALESCE(SUM(l.principal), 0) AS dr, 0 AS cr
       FROM loans l
       JOIN products p ON l.product_id = p.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2 AND p.category = 'loan'
         AND EXTRACT(YEAR FROM l.date_issued) = $4
       GROUP BY p.id, p.name, period`,
      [id, coopId, truncUnit, year],
    );
    const loanCrResult = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              date_trunc($3, r.repayment_date) AS period,
              0 AS dr, COALESCE(SUM(r.amount), 0) AS cr
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       JOIN products p ON l.product_id = p.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2 AND p.category = 'loan'
         AND EXTRACT(YEAR FROM r.repayment_date) = $4
       GROUP BY p.id, p.name, period`,
      [id, coopId, truncUnit, year],
    );
    const loanBfResult = await pool.query(
      `SELECT p.id AS product_id,
              COALESCE(SUM(l.principal), 0) - COALESCE((
                SELECT SUM(r.amount) FROM loan_repayments r
                JOIN loans l2 ON r.loan_id = l2.id
                WHERE l2.member_id = $1 AND l2.product_id = p.id AND l2.cooperative_id = $2
                  AND r.repayment_date < ($3 || '-01-01')::date
              ), 0) AS bf
       FROM loans l
       JOIN products p ON l.product_id = p.id
       WHERE l.member_id = $1 AND l.cooperative_id = $2 AND p.category = 'loan'
         AND l.date_issued < ($3 || '-01-01')::date
       GROUP BY p.id`,
      [id, coopId, year],
    );
    const loanBfMap = {};
    loanBfResult.rows.forEach((r) => {
      loanBfMap[r.product_id] = parseFloat(r.bf);
    });

    const buildBlocks = (rows, bfLookup, normalBalance = "credit") => {
      const byProduct = {};
      rows.forEach((r) => {
        if (!byProduct[r.product_id]) {
          byProduct[r.product_id] = {
            product_name: r.product_name,
            bf: bfLookup[r.product_id] || 0,
            periods: {},
          };
        }
        const key = r.period.toISOString();
        if (!byProduct[r.product_id].periods[key]) {
          byProduct[r.product_id].periods[key] = {
            period: r.period,
            dr: 0,
            cr: 0,
          };
        }
        byProduct[r.product_id].periods[key].dr += parseFloat(r.dr);
        byProduct[r.product_id].periods[key].cr += parseFloat(r.cr);
      });

      return Object.values(byProduct).map((block) => {
        let running = block.bf;
        const periods = Object.values(block.periods)
          .sort((a, b) => new Date(a.period) - new Date(b.period))
          .map((p) => {
            // Debit-normal (loans): DR increases balance, CR decreases it
            // Credit-normal (savings): CR increases balance, DR decreases it
            running += normalBalance === "debit" ? p.dr - p.cr : p.cr - p.dr;
            return { period: p.period, dr: p.dr, cr: p.cr, balance: running };
          });
        return { product_name: block.product_name, bf: block.bf, periods };
      });
    };

    const savingsBlocks = buildBlocks(savingsResult.rows, bfMap, "credit");
    const loanBlocks = buildBlocks(
      [...loanDrResult.rows, ...loanCrResult.rows],
      loanBfMap,
      "debit",
    );

    res.json({ savings: savingsBlocks, loans: loanBlocks });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMyAccountsLedger = async (req, res) => {
  req.params.id = req.user.memberId;
  return getMemberAccountsLedger(req, res);
};
