import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getContributionsSummary,
  getLoansSummary,
  getBalancesByProduct,
  getPaymentsLedger,
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
  "/balances-by-product",
  verifyToken,
  requireAdmin,
  getBalancesByProduct,
);
router.get("/payments-ledger", verifyToken, requireAdmin, getPaymentsLedger);
export default router;
