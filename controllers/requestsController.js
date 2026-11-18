import pool from "../config/db.js";

const MAX_PENDING = 5;
const text = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

// One entry per request type: how to check what the member sent, and what approval does.
// Later pieces add withdrawal, contribution and loan here.
const TYPES = {
  contact: {
    label: "Update phone or email",
    async validate(body) {
      const phone = text(body.phone, 20);
      const email = text(body.email, 120).toLowerCase();
      if (!phone && !email)
        return { error: "Enter a new phone number or email" };
      if (phone && !/^[0-9+()\s-]{6,20}$/.test(phone))
        return { error: "That phone number doesn't look right" };
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { error: "That email address doesn't look right" };
      return { details: { phone: phone || null, email: email || null } };
    },
    async approve(client, { coopId, request }) {
      const d = request.details;
      await client.query(
        "UPDATE members SET phone = COALESCE($1, phone), email = COALESCE($2, email) WHERE id = $3 AND cooperative_id = $4",
        [d.phone, d.email, request.member_id, coopId],
      );
      return {
        status: "done",
        message: `Contact details updated for ${request.full_name}.`,
      };
    },
  },
};

const typeOf = (key) =>
  Object.prototype.hasOwnProperty.call(TYPES, key) ? TYPES[key] : null;
const withLabel = (row) => ({
  ...row,
  type_label: typeOf(row.type)?.label || row.type,
});

// ---------- Member ----------

export const createRequest = async (req, res) => {
  try {
    const { memberId, cooperativeId: coopId } = req.user;
    const type = typeOf(req.body?.type);
    if (!type)
      return res
        .status(400)
        .json({ error: "That kind of request isn't available yet" });

    const pending = await pool.query(
      "SELECT COUNT(*)::int AS n FROM member_requests WHERE member_id = $1 AND status = 'pending'",
      [memberId],
    );
    if (pending.rows[0].n >= MAX_PENDING) {
      return res
        .status(400)
        .json({
          error: `You already have ${MAX_PENDING} requests waiting. Please wait for your admin to respond.`,
        });
    }

    const checked = await type.validate(req.body, { coopId, memberId });
    if (checked.error) return res.status(400).json({ error: checked.error });

    await pool.query(
      `INSERT INTO member_requests (cooperative_id, member_id, type, details, member_note)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        coopId,
        memberId,
        req.body.type,
        JSON.stringify(checked.details),
        text(req.body.note, 500) || null,
      ],
    );
    res
      .status(201)
      .json({ message: "Request sent. Your admin will respond here." });
  } catch (err) {
    console.error("createRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const listMyRequests = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, details, member_note, status, admin_note, created_at, decided_at
       FROM member_requests
       WHERE member_id = $1 AND cooperative_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.memberId, req.user.cooperativeId],
    );
    res.json(result.rows.map(withLabel));
  } catch (err) {
    console.error("listMyRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const cancelMyRequest = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE member_requests SET status = 'cancelled', decided_at = NOW()
       WHERE id = $1 AND member_id = $2 AND cooperative_id = $3 AND status = 'pending'
       RETURNING id`,
      [req.params.id, req.user.memberId, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "That request can't be cancelled" });
    res.json({ message: "Request cancelled" });
  } catch (err) {
    console.error("cancelMyRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// ---------- Admin ----------

export const listRequests = async (req, res) => {
  try {
    const allowed = ["pending", "approved", "done", "declined", "cancelled"];
    const status =
      req.query.status === "all"
        ? null
        : allowed.includes(req.query.status)
          ? req.query.status
          : "pending";

    const result = await pool.query(
      `SELECT r.id, r.type, r.details, r.member_note, r.status, r.admin_note, r.created_at, r.decided_at,
              r.member_id, m.full_name, m.member_number, m.phone AS current_phone, m.email AS current_email
       FROM member_requests r
       JOIN members m ON m.id = r.member_id
       WHERE r.cooperative_id = $1 AND ($2::text IS NULL OR r.status = $2)
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC
       LIMIT 200`,
      [req.user.cooperativeId, status],
    );
    res.json(result.rows.map(withLabel));
  } catch (err) {
    console.error("listRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const countRequests = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM member_requests WHERE cooperative_id = $1 AND status = 'pending'",
      [req.user.cooperativeId],
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("countRequests failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const approveRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const coopId = req.user.cooperativeId;
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT r.*, m.full_name
       FROM member_requests r JOIN members m ON m.id = r.member_id
       WHERE r.id = $1 AND r.cooperative_id = $2
       FOR UPDATE OF r`,
      [req.params.id, coopId],
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }
    const request = found.rows[0];
    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "This request has already been handled" });
    }
    const type = typeOf(request.type);
    if (!type) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "This kind of request can't be approved yet" });
    }

    const outcome = await type.approve(client, {
      coopId,
      request,
      body: req.body || {},
    });

    await client.query(
      `UPDATE member_requests
       SET status = $1, details = $2::jsonb, admin_note = $3, decided_by = $4, decided_at = NOW()
       WHERE id = $5`,
      [
        outcome.status,
        JSON.stringify(outcome.details || request.details),
        text(req.body?.admin_note, 500) || null,
        req.user.userId,
        request.id,
      ],
    );
    await client.query("COMMIT");
    res.json({ message: outcome.message });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approveRequest failed:", err);
    if (err.code === "23505")
      return res
        .status(409)
        .json({
          error: "That email address is already used by another member",
        });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
};

export const declineRequest = async (req, res) => {
  try {
    const note = text(req.body?.admin_note, 500);
    if (!note)
      return res.status(400).json({ error: "Give the member a short reason" });

    const result = await pool.query(
      `UPDATE member_requests
       SET status = 'declined', admin_note = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3 AND cooperative_id = $4 AND status = 'pending'
       RETURNING id`,
      [note, req.user.userId, req.params.id, req.user.cooperativeId],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ error: "That request isn't waiting any more" });
    res.json({ message: "Request declined" });
  } catch (err) {
    console.error("declineRequest failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
