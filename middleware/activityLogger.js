import pool from "../config/db.js";

const CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const VERBS = {
  POST: "Added",
  PUT: "Changed",
  PATCH: "Changed",
  DELETE: "Deleted",
};

// Never stored, whatever route they arrive on
const SECRET_KEY = /pass|token|secret|hash/i;

// The only request fields kept, to show what was touched
const KEEP_KEYS = new Set([
  "member_id",
  "product_id",
  "loan_id",
  "amount",
  "principal",
  "duration_value",
  "duration_unit",
  "date",
  "entry_date",
  "payment_date",
  "repayment_date",
  "contribution_date",
  "date_issued",
  "username",
  "role",
  "name",
  "full_name",
  "member_number",
  "type",
  "status",
  "year",
  "description",
]);

// Not worth recording: logout and read-only checks sent as POST
const IGNORED =
  /^POST \/api\/auth\/|\/(preview|validate|check|dry-run|search|lookup)$/;

const NOUNS = {
  members: "member",
  loans: "loan",
  contributions: "contribution",
  products: "product",
  payments: "payment",
  journal: "journal entry",
  users: "user login",
  notices: "notice",
  "carry-forward": "carry forward",
  "bank-import": "bank loan import",
  "bulk-payments": "bulk payments",
  "chart-of-accounts": "chart of accounts",
  cooperative: "cooperative settings",
  requests: "member request",
  "my-requests": "request",
  "member-dues": "contribution amounts",
  "super-admin": "platform admin",
  backup: "backup",
};

// Exact wording for the actions people will look for. Checked in order.
const WORDING = [
  [/^POST \/api\/auth\/change-password$/, "Changed their own password"],
  [/^POST \/api\/password\/change$/, "Changed their own password"],
  [
    /^POST \/api\/password\/requests\/:id\/dismiss$/,
    "Dismissed a password reset request",
  ],
  [/^POST \/api\/users$/, "Created a user login"],
  [/^PUT \/api\/users\/:id\/role$/, "Changed a user's role"],
  [/^(PUT|POST) \/api\/users\/:id\/reset-password$/, "Reset a user's password"],
  [/^DELETE \/api\/users\/:id$/, "Removed a user login"],
  [
    /^(PUT|POST) \/api\/super-admin\/users\/:id\/reset-password$/,
    "Reset a cooperative admin's password",
  ],
  [
    /^POST \/api\/super-admin\/users\/:id\/dismiss-request$/,
    "Dismissed an admin's reset request",
  ],
  [/^POST \/api\/super-admin\/cooperatives$/, "Created a cooperative"],
  [/^POST \/api\/requests\/:id\/approve$/, "Approved a member request"],
  [/^POST \/api\/requests\/:id\/decline$/, "Declined a member request"],
  [
    /^POST \/api\/requests\/:id\/complete$/,
    "Marked an approved loan as issued",
  ],
  [/^PUT \/api\/requests\/rules$/, "Changed the request rules"],
  [/^POST \/api\/my-requests$/, "Sent a request to the admin"],
  [/^POST \/api\/my-requests\/:id\/cancel$/, "Cancelled a request"],
  [/^PUT \/api\/member-dues$/, "Changed contribution amounts"],
  [/^POST \/api\/notices$/, "Posted a notice"],
  [/^PUT \/api\/notices\/:id$/, "Edited a notice"],
  [/^DELETE \/api\/notices\/:id$/, "Deleted a notice"],
  [/^(PUT|PATCH|POST) \/api\/cooperative$/, "Changed cooperative settings"],
  [/^POST \/api\/loans$/, "Issued a loan"],
  [/^DELETE \/api\/loans\/:id$/, "Deleted a loan"],
  [/^GET \/api\/backup/, "Downloaded a backup"],
];

// "/api/loans/12" -> "/api/loans/:id"
const normalise = (url) =>
  String(url || "")
    .split("?")[0]
    .replace(/\/+$/, "")
    .toLowerCase()
    .split("/")
    .map((part) => (/^\d+$/.test(part) ? ":id" : part))
    .join("/");

const describe = (method, path) => {
  const known = WORDING.find(([pattern]) => pattern.test(`${method} ${path}`));
  if (known) return known[1];

  const parts = path
    .replace(/^\/api\//, "")
    .split("/")
    .filter((p) => p && p !== ":id");
  const noun = NOUNS[parts[0]] || parts[0] || "item";
  const rest = parts.slice(1).join(" ").replace(/-/g, " ");
  const verb = /import/.test(path) ? "Imported" : VERBS[method] || method;
  return `${verb} ${[noun, rest].filter(Boolean).join(" ")}`;
};

// What was touched, without anything private: ids from the URL, a short list of safe fields, and row counts
const safeDetails = (req) => {
  const details = {};
  Object.entries(req.params || {}).forEach(([k, v]) => {
    details[k] = String(v).slice(0, 40);
  });

  const body = req.body;
  if (Array.isArray(body)) {
    details.rows = body.length;
  } else if (body && typeof body === "object") {
    Object.entries(body).forEach(([k, v]) => {
      if (SECRET_KEY.test(k)) return;
      if (Array.isArray(v)) {
        details[`${k}_count`] = v.length;
        return;
      }
      if (!KEEP_KEYS.has(k)) return;
      if (typeof v === "number" || typeof v === "boolean") details[k] = v;
      else if (typeof v === "string") details[k] = v.slice(0, 120);
    });
  }
  return details;
};

const usernames = new Map();
const usernameOf = async (userId) => {
  if (usernames.has(userId)) return usernames.get(userId);
  const result = await pool.query("SELECT username FROM users WHERE id = $1", [
    userId,
  ]);
  const name = result.rows[0]?.username || `user ${userId}`;
  usernames.set(userId, name);
  return name;
};

const insert = (entry) =>
  pool.query(
    `INSERT INTO activity_log (cooperative_id, user_id, username, role, action, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      entry.cooperativeId,
      entry.userId,
      entry.username,
      entry.role,
      entry.action,
      entry.summary,
      JSON.stringify(entry.details || {}),
      entry.ip || null,
    ],
  );

// Logins and "forgot password" come from people who aren't signed in, so they are matched by the username typed
const recordPublic = async (req, path, status) => {
  const typed = String(req.body?.username || "")
    .trim()
    .slice(0, 50);
  if (typed.length < 3) return;

  const found = await pool.query(
    "SELECT id, username, role, cooperative_id FROM users WHERE LOWER(username) = LOWER($1)",
    [typed],
  );
  const user = found.rows[0];
  if (!user) return; // made-up usernames aren't logged

  let summary;
  if (path === "/api/auth/login") {
    if (status === 200) summary = "Logged in";
    else if ([400, 401, 403].includes(status)) summary = "Failed login attempt";
    else return;
  } else {
    if (status !== 200) return;
    summary = "Asked for a password reset";
  }

  await insert({
    cooperativeId: user.cooperative_id,
    userId: user.id,
    username: user.username,
    role: user.role,
    action: `POST ${path}`,
    summary,
    details: {},
    ip: req.ip,
  });
};

const record = async (req, res) => {
  const method = req.method;
  const path = normalise(req.originalUrl || req.url);

  if (
    method === "POST" &&
    (path === "/api/auth/login" || path === "/api/password/forgot")
  ) {
    return recordPublic(req, path, res.statusCode);
  }

  if (res.statusCode >= 400 || !req.user) return; // only things that actually happened, by someone signed in
  const isBackupDownload = method === "GET" && path.startsWith("/api/backup");
  if (!CHANGING.has(method) && !isBackupDownload) return;
  if (IGNORED.test(`${method} ${path}`)) return;

  await insert({
    cooperativeId: req.user.cooperativeId ?? null,
    userId: req.user.userId ?? null,
    username: await usernameOf(req.user.userId),
    role: req.user.role,
    action: `${method} ${path}`,
    summary: describe(method, path),
    details: safeDetails(req),
    ip: req.ip,
  });
};

// Runs after the response is sent, so it can never slow down or break a request
export const activityLogger = (req, res, next) => {
  res.on("finish", () => {
    record(req, res).catch((err) =>
      console.error("activity log failed:", err.message),
    );
  });
  next();
};
