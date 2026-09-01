import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { body, validationResult } from "express-validator";

import {
  getAccounts,
  createJournalEntry,
  getTrialBalance,
  getIncomeExpenditure,
  getBalanceSheet,
  getAccountLedger,
} from "../controllers/journalController.js";

const router = express.Router();

const validateJournalEntry = [
  // eslint-disable-next-line no-undef
  body("entry_date").isISO8601().withMessage("Valid entry date is required"),
  // eslint-disable-next-line no-undef
  body("lines")
    .isArray({ min: 2 })
    .withMessage("At least 2 lines are required"),
];

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

router.get("/accounts", verifyToken, requireAdmin, getAccounts);
router.get("/trial-balance", verifyToken, requireAdmin, getTrialBalance);
router.post(
  "/entries",
  verifyToken,
  requireAdmin,
  validateJournalEntry,
  handleValidation,
  createJournalEntry,
);
router.get(
  "/income-expenditure",
  verifyToken,
  requireAdmin,
  getIncomeExpenditure,
);
router.get("/balance-sheet", verifyToken, requireAdmin, getBalanceSheet);
router.get(
  "/accounts/:accountId/ledger",
  verifyToken,
  requireAdmin,
  getAccountLedger,
);

export default router;
