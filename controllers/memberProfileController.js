import pool from "../config/db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[0-9+()\s-]{6,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SELECT = `id, full_name, member_number, phone, email, address,
                next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
                occupation, department, bank_name, bank_account_number, status,
                to_char(date_joined, 'YYYY-MM-DD') AS date_joined,
                to_char(retirement_date, 'YYYY-MM-DD') AS retirement_date`;

// Each cleaner returns { value } or { error }
const textOf = (label, max) => (v) => {
  const s = String(v ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (s.length > max)
    return { error: `${label} is too long (up to ${max} characters)` };
  return { value: s || null };
};
const phoneOf = (label) => (v) => {
  const s = String(v ?? "").trim();
  if (!s) return { value: null };
  if (!PHONE_RE.test(s))
    return { error: `${label} doesn't look right. Use digits, spaces, + or -` };
  return { value: s };
};
const dateOf = (label) => (v) => {
  const s = String(v ?? "").trim();
  if (!s) return { value: null };
  const d = new Date(`${s}T00:00:00`);
  const year = d.getFullYear();
  if (
    !DATE_RE.test(s) ||
    Number.isNaN(d.getTime()) ||
    year < 1900 ||
    year > 2100
  ) {
    return { error: `${label} isn't a valid date` };
  }
  return { value: s };
};

const FIELDS = [
  {
    key: "full_name",
    label: "Name",
    clean: (v) => {
      const s = String(v ?? "")
        .trim()
        .replace(/\s+/g, " ");
      if (!s) return { error: "The member's name can't be empty" };
      if (s.length > 120)
        return { error: "The name is too long (up to 120 characters)" };
      return { value: s };
    },
  },
  {
    key: "member_number",
    label: "Member number",
    clean: textOf("The member number", 30),
  },
  { key: "phone", label: "Phone", clean: phoneOf("The phone number") },
  {
    key: "email",
    label: "Email",
    clean: (v) => {
      const s = String(v ?? "")
        .trim()
        .toLowerCase();
      if (!s) return { value: null };
      if (s.length > 120 || !EMAIL_RE.test(s))
        return { error: "That email address doesn't look right" };
      return { value: s };
    },
  },
  { key: "address", label: "Address", clean: textOf("The address", 300) },
  {
    key: "next_of_kin_name",
    label: "Next of kin",
    clean: textOf("The next of kin's name", 120),
  },
  {
    key: "next_of_kin_phone",
    label: "Next of kin phone",
    clean: phoneOf("The next of kin's phone number"),
  },
  {
    key: "next_of_kin_relationship",
    label: "Relationship",
    clean: textOf("The relationship", 50),
  },
  {
    key: "occupation",
    label: "Occupation",
    clean: textOf("The occupation", 100),
  },
  {
    key: "department",
    label: "Department",
    clean: textOf("The department", 100),
  },
  {
    key: "date_joined",
    label: "Date joined",
    clean: dateOf("The date joined"),
  },
  {
    key: "retirement_date",
    label: "Retirement date",
    clean: dateOf("The retirement date"),
  },
  { key: "bank_name", label: "Bank", clean: textOf("The bank name", 80) },
  {
    key: "bank_account_number",
    label: "Account number",
    clean: (v) => {
      const s = String(v ?? "").replace(/[\s-]/g, "");
      if (!s) return { value: null };
      if (!/^\d{6,20}$/.test(s))
        return { error: "The account number should be 6 to 20 digits" };
      return { value: s };
    },
  },
];

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const getMemberProfile = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: "Member not found" });
    const result = await pool.query(
      `SELECT ${SELECT} FROM members WHERE id = $1 AND cooperative_id = $2`,
      [id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("getMemberProfile failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Only the fields that actually changed are checked and saved
export const updateMemberProfile = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: "Member not found" });

    const found = await pool.query(
      `SELECT ${SELECT} FROM members WHERE id = $1 AND cooperative_id = $2`,
      [id, coopId],
    );
    if (found.rows.length === 0)
      return res.status(404).json({ error: "Member not found" });
    const current = found.rows[0];
    const body = req.body || {};

    const updates = {};
    const changedLabels = [];
    for (const field of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, field.key)) continue;
      const raw = String(body[field.key] ?? "").trim();
      if (raw === String(current[field.key] ?? "")) continue; // untouched, so it is never re-checked

      const cleaned = field.clean(body[field.key]);
      if (cleaned.error) return res.status(400).json({ error: cleaned.error });
      if ((cleaned.value ?? null) === (current[field.key] ?? null)) continue;

      updates[field.key] = cleaned.value;
      changedLabels.push(field.label);
    }

    if (changedLabels.length === 0)
      return res.json({ message: "Nothing to change", member: current });

    const finalJoined =
      "date_joined" in updates ? updates.date_joined : current.date_joined;
    const finalRetire =
      "retirement_date" in updates
        ? updates.retirement_date
        : current.retirement_date;
    if (finalJoined && finalRetire && finalRetire < finalJoined) {
      return res
        .status(400)
        .json({ error: "The retirement date can't be before the date joined" });
    }

    // Column names come from the fixed list above, never from the request
    const keys = Object.keys(updates);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    const result = await pool.query(
      `UPDATE members SET ${setClause} WHERE id = $${keys.length + 1} AND cooperative_id = $${keys.length + 2}
       RETURNING ${SELECT}`,
      [...keys.map((k) => updates[k]), id, coopId],
    );

    // Picked up by the Activity Log: who changed which fields (field names only, no values)
    res.locals.activityDetails = {
      member_id: id,
      changed: changedLabels.join(", "),
    };
    res.json({
      message: `Saved: ${changedLabels.join(", ")}`,
      member: result.rows[0],
    });
  } catch (err) {
    console.error("updateMemberProfile failed:", err);
    if (err.code === "23505") {
      const message = String(err.constraint || "").includes("email")
        ? "Another member in your cooperative already has this email address"
        : String(err.constraint || "").includes("member_number")
          ? "Another member in your cooperative already has this member number"
          : "That clashes with another member's details";
      return res.status(409).json({ error: message });
    }
    res.status(500).json({ error: "Server error" });
  }
};

// The whole directory in one call, with what each member still owes on active loans
export const listMemberProfiles = async (req, res) => {
  try {
    const coopId = req.user.cooperativeId;
    const result = await pool.query(
      `SELECT m.id, m.full_name, m.member_number, m.phone, m.email, m.address,
              m.next_of_kin_name, m.next_of_kin_phone, m.next_of_kin_relationship,
              m.occupation, m.department, m.bank_name, m.bank_account_number, m.status,
              to_char(m.date_joined, 'YYYY-MM-DD') AS date_joined,
              to_char(m.retirement_date, 'YYYY-MM-DD') AS retirement_date,
              COALESCE((
                SELECT SUM((l.principal + COALESCE(l.interest_amount, 0)) - COALESCE(rp.repaid, 0))
                FROM loans l
                LEFT JOIN (
                  SELECT loan_id, SUM(amount) AS repaid FROM loan_repayments
                  WHERE cooperative_id = $1 GROUP BY loan_id
                ) rp ON rp.loan_id = l.id
                WHERE l.member_id = m.id AND l.cooperative_id = $1 AND l.status = 'active'
              ), 0) AS loans_owed
       FROM members m
       WHERE m.cooperative_id = $1
       ORDER BY m.full_name`,
      [coopId],
    );
    res.json(
      result.rows.map((r) => ({
        ...r,
        loans_owed: Math.round(parseFloat(r.loans_owed) * 100) / 100,
      })),
    );
  } catch (err) {
    console.error("listMemberProfiles failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
