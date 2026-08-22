export async function postJournal(
  client,
  { entry_date, description, source, source_id, cooperativeId, lines },
) {
  const totalDebit = lines.reduce(
    (sum, l) => sum + (parseFloat(l.debit) || 0),
    0,
  );
  const totalCredit = lines.reduce(
    (sum, l) => sum + (parseFloat(l.credit) || 0),
    0,
  );

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Journal entry does not balance: debit ${totalDebit} vs credit ${totalCredit}`,
    );
  }

  const entryResult = await client.query(
    `INSERT INTO journal_entries (entry_date, description, source, source_id, cooperative_id) 
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [entry_date, description, source, source_id, cooperativeId],
  );
  const entryId = entryResult.rows[0].id;

  for (const line of lines) {
    if (
      (parseFloat(line.debit) || 0) === 0 &&
      (parseFloat(line.credit) || 0) === 0
    )
      continue;
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, cooperative_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entryId,
        line.account_id,
        line.debit || 0,
        line.credit || 0,
        cooperativeId,
      ],
    );
  }
}

export async function getDefaultCashAccount(client, cooperativeId) {
  const result = await client.query(
    "SELECT default_cash_account_id FROM settings WHERE cooperative_id = $1",
    [cooperativeId],
  );
  return result.rows[0].default_cash_account_id;
}
