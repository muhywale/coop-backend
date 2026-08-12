import pool from "../config/db.js";

export const getAccounts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM chart_of_accounts WHERE active = true ORDER BY code",
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};

// Record a journal entry with 2+ balanced lines
export const createJournalEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const { entry_date, description, lines } = req.body;
    // lines: [{ account_id, debit, credit }, ...]

    const totalDebit = lines.reduce(
      (sum, l) => sum + (parseFloat(l.debit) || 0),
      0,
    );
    const totalCredit = lines.reduce(
      (sum, l) => sum + (parseFloat(l.credit) || 0),
      0,
    );

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({
        error: `Entry does not balance: debits ${totalDebit}, credits ${totalCredit}`,
      });
    }

    await client.query("BEGIN");

    const entryResult = await client.query(
      `INSERT INTO journal_entries (entry_date, description, source) VALUES ($1, $2, 'manual') RETURNING id`,
      [entry_date, description],
    );
    const entryId = entryResult.rows[0].id;

    for (const line of lines) {
      if (
        (parseFloat(line.debit) || 0) === 0 &&
        (parseFloat(line.credit) || 0) === 0
      )
        continue;
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
        [entryId, line.account_id, line.debit || 0, line.credit || 0],
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Journal entry recorded", id: entryId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// Trial Balance — the core report
export const getTrialBalance = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.code, a.name, a.account_type,
              COALESCE(SUM(l.debit), 0) AS total_debit,
              COALESCE(SUM(l.credit), 0) AS total_credit
       FROM chart_of_accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       WHERE a.active = true
       GROUP BY a.id, a.code, a.name, a.account_type
       ORDER BY a.code`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error" });
  }
};
