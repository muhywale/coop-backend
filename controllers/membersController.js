import pool from "../config/db.js";
// GET all members
export const getMembers = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM members ORDER BY id");
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
    const result = await pool.query("SELECT * FROM members WHERE id = $1", [
      id,
    ]);
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
    const { full_name, email, phone } = req.body;
    const result = await pool.query(
      "INSERT INTO members (full_name, email, phone) VALUES ($1, $2, $3) RETURNING *",
      [full_name, email, phone],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// PUT update member
export const updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, status } = req.body;
    const result = await pool.query(
      "UPDATE members SET full_name=$1, email=$2, phone=$3, status=$4 WHERE id=$5 RETURNING *",
      [full_name, email, phone, status, id],
    );
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
    await pool.query("DELETE FROM members WHERE id = $1", [id]);
    res.json({ message: "Member deleted" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getMemberDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const memberResult = await pool.query(
      "SELECT * FROM members WHERE id = $1",
      [id],
    );
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const balanceResult = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'savings' THEN amount 
                                 WHEN type = 'withdrawal' THEN -amount 
                                 ELSE 0 END), 0) AS balance
       FROM contributions WHERE member_id = $1`,
      [id],
    );

    const contributionsResult = await pool.query(
      `SELECT * FROM contributions WHERE member_id = $1 ORDER BY contribution_date DESC`,
      [id],
    );

    const loansResult = await pool.query(
      `SELECT l.*, l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1
       GROUP BY l.id
       ORDER BY l.date_issued DESC`,
      [id],
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
  try {
    const memberId = req.user.memberId;

    const memberResult = await pool.query(
      "SELECT * FROM members WHERE id = $1",
      [memberId],
    );
    const balanceResult = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'savings' THEN amount 
                                 WHEN type = 'withdrawal' THEN -amount 
                                 ELSE 0 END), 0) AS balance
       FROM contributions WHERE member_id = $1`,
      [memberId],
    );
    const contributionsResult = await pool.query(
      `SELECT * FROM contributions WHERE member_id = $1 ORDER BY contribution_date DESC`,
      [memberId],
    );
    const loansResult = await pool.query(
      `SELECT l.*, l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1 GROUP BY l.id ORDER BY l.date_issued DESC`,
      [memberId],
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
export const getMemberTransactions = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
         id, 'contribution' AS source, type, amount, contribution_date AS date, notes
       FROM contributions
       WHERE member_id = $1

       UNION ALL

       SELECT 
         id, 'loan_issued' AS source, 'loan' AS type, principal AS amount, date_issued AS date, 
         'Loan issued' AS notes
       FROM loans
       WHERE member_id = $1

       UNION ALL

       SELECT 
         r.id, 'loan_repayment' AS source, 'loan_repayment' AS type, r.amount, r.repayment_date AS date,
         'Repayment on loan #' || r.loan_id AS notes
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       WHERE l.member_id = $1

       ORDER BY date DESC`,
      [id],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getMyTransactions = async (req, res) => {
  try {
    const memberId = req.user.memberId;

    const result = await pool.query(
      `SELECT 
         id, 'contribution' AS source, type, amount, contribution_date AS date, notes
       FROM contributions
       WHERE member_id = $1

       UNION ALL

       SELECT 
         id, 'loan_issued' AS source, 'loan' AS type, principal AS amount, date_issued AS date, 
         'Loan issued' AS notes
       FROM loans
       WHERE member_id = $1

       UNION ALL

       SELECT 
         r.id, 'loan_repayment' AS source, 'loan_repayment' AS type, r.amount, r.repayment_date AS date,
         'Repayment on loan #' || r.loan_id AS notes
       FROM loan_repayments r
       JOIN loans l ON r.loan_id = l.id
       WHERE l.member_id = $1

       ORDER BY date DESC`,
      [memberId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
export const getMemberLedgerByProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const savings = await pool.query(
      `SELECT c.id, p.name AS product_name, c.type, c.amount, c.contribution_date AS date, c.notes
       FROM contributions c
       JOIN products p ON c.product_id = p.id
       WHERE c.member_id = $1
       ORDER BY p.name, c.contribution_date`,
      [id],
    );

    const loans = await pool.query(
      `SELECT l.id, p.name AS product_name, l.principal, l.interest_rate, l.date_issued, l.status,
              l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1
       GROUP BY l.id, p.name
       ORDER BY p.name, l.date_issued`,
      [id],
    );

    // group savings transactions by product name
    const savingsByProduct = {};
    savings.rows.forEach((row) => {
      if (!savingsByProduct[row.product_name])
        savingsByProduct[row.product_name] = [];
      savingsByProduct[row.product_name].push(row);
    });

    // group loans by product name
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
  try {
    const memberId = req.user.memberId;

    const savings = await pool.query(
      `SELECT c.id, p.name AS product_name, c.type, c.amount, c.contribution_date AS date, c.notes
       FROM contributions c
       JOIN products p ON c.product_id = p.id
       WHERE c.member_id = $1
       ORDER BY p.name, c.contribution_date`,
      [memberId],
    );

    const loans = await pool.query(
      `SELECT l.id, p.name AS product_name, l.principal, l.interest_rate, l.date_issued, l.status,
              l.principal - COALESCE(SUM(r.amount), 0) AS outstanding_balance
       FROM loans l
       JOIN products p ON l.product_id = p.id
       LEFT JOIN loan_repayments r ON r.loan_id = l.id
       WHERE l.member_id = $1
       GROUP BY l.id, p.name
       ORDER BY p.name, l.date_issued`,
      [memberId],
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
