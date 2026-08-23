import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  distributePayment,
  withdrawFunds,
  correctContribution,
  bulkImportPayments,
  bulkImportLoanRepayments,
  bulkImportLoans,
  bulkImportOpeningBalances,
} from "../controllers/paymentsController.js";

const router = express.Router();
router.post("/distribute", verifyToken, requireAdmin, distributePayment);
router.post("/withdraw", verifyToken, requireAdmin, withdrawFunds);

router.delete(
  "/contributions/:id/correct",
  verifyToken,
  requireAdmin,
  correctContribution,
);

router.post("/bulk-import", verifyToken, requireAdmin, bulkImportPayments);
router.post(
  "/bulk-import-loan-repayments",
  verifyToken,
  requireAdmin,
  bulkImportLoanRepayments,
);

router.post("/bulk-import-loans", verifyToken, requireAdmin, bulkImportLoans);
export default router;
router.post(
  "/bulk-import-opening-balances",
  verifyToken,
  requireAdmin,
  bulkImportOpeningBalances,
);
