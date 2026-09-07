import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getContributionsSummary,
  getLoansSummary,
  getBalancesByProduct,
  getPaymentsLedger,
  getMyPaymentsLedger,
  getMemberPaymentsLedger,
  getDashboardStats,
} from "../controllers/dashboardController.js";

const router = express.Router();

router.get(
  "/contributions-summary",
  verifyToken,
  requireAdmin,
  getContributionsSummary,
);
router.get("/loans-summary", verifyToken, requireAdmin, getLoansSummary);

router.get(
  "/member-balances",
  verifyToken,
  requireAdmin,
  getBalancesByProduct,
  getMyPaymentsLedger,
);
router.get("/payments-ledger", verifyToken, requireAdmin, getPaymentsLedger);

router.get(
  "/member/:memberId/payments-ledger",
  verifyToken,
  requireAdmin,
  getMemberPaymentsLedger,
);
router.get("/my-payments-ledger", verifyToken, getMyPaymentsLedger);
export default router;
router.get("/stats", verifyToken, requireAdmin, getDashboardStats);
