import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

import membersRoutes from "./routes/members.js";
import contributionsRoutes from "./routes/contributions.js";
import loansRoutes from "./routes/loans.js";
import authRoutes from "./routes/auth.js";
import productsRoutes from "./routes/products.js";
import dashboardRoutes from "./routes/dashboard.js";
import paymentsRoutes from "./routes/payments.js";
import journalRoutes from "./routes/journal.js";
import superAdminRoutes from "./routes/superAdmin.js";
import chartOfAccountsRoutes from "./routes/chartOfAccounts.js";

dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "https://coop-frontend-xi.vercel.app",
];
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  handler: (req, res) => {
    console.log("Rate limit triggered for:", req.ip);
    res
      .status(429)
      .json({
        error: "Too many login attempts. Please try again in 15 minutes.",
      });
  },
});

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/change-password", changePasswordLimiter);

app.use("/api/members", membersRoutes);
app.use("/api/contributions", contributionsRoutes);
app.use("/api/loans", loansRoutes);
app.use("/api/loans", loansRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/journal", journalRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api/chart-of-accounts", chartOfAccountsRoutes);

//console.log("JWT_SECRET is", process.env.JWT_SECRET);

// eslint-disable-next-line no-undef
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
