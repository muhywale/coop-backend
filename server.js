import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import membersRoutes from "./routes/members.js";
import contributionsRoutes from "./routes/contributions.js";
import loansRoutes from "./routes/loans.js";
import authRoutes from "./routes/auth.js";
import productsRoutes from "./routes/products.js";
import dashboardRoutes from "./routes/dashboard.js";
import paymentsRoutes from "./routes/payments.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/members", membersRoutes);
app.use("/api/contributions", contributionsRoutes);
app.use("/api/loans", loansRoutes);
app.use("/api/loans", loansRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/payments", paymentsRoutes);

// eslint-disable-next-line no-undef
console.log("JWT_SECRET is", process.env.JWT_SECRET);

// eslint-disable-next-line no-undef
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
