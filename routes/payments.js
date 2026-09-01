import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { body, validationResult } from "express-validator";

import {
  distributePayment,
  withdrawFunds,
  correctContribution,
  bulkImportPayments,
  bulkImportLoanRepayments,
  bulkImportLoans,
  bulkImportOpeningBalances,
  bulkImportOpeningTrialBalance,
  bulkImportMembers,
} from "../controllers/paymentsController.js";

const router = express.Router();

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

const validateDistribute = [
  body("member_id").isInt({ min: 1 }).withMessage("Valid member is required"),
  body("date").isISO8601().withMessage("Valid date is required"),
];

router.post(
  "/distribute",
  verifyToken,
  requireAdmin,
  validateDistribute,
  handleValidation,
  distributePayment,
);
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
router.post(
  "/bulk-import-opening-trial-balance",
  verifyToken,
  requireAdmin,
  bulkImportOpeningTrialBalance,
);
router.post(
  "/bulk-import-members",
  verifyToken,
  requireAdmin,
  bulkImportMembers,
);
