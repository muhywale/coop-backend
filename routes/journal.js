import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getAccounts,
  createJournalEntry,
  getTrialBalance,
  getIncomeExpenditure,
  getBalanceSheet,
  getAccountLedger,
} from "../controllers/journalController.js";

const router = express.Router();

router.get("/accounts", verifyToken, requireAdmin, getAccounts);
router.post("/entries", verifyToken, requireAdmin, createJournalEntry);
router.get("/trial-balance", verifyToken, requireAdmin, getTrialBalance);
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
