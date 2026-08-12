import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getAccounts,
  createJournalEntry,
  getTrialBalance,
} from "../controllers/journalController.js";

const router = express.Router();

router.get("/accounts", verifyToken, requireAdmin, getAccounts);
router.post("/entries", verifyToken, requireAdmin, createJournalEntry);
router.get("/trial-balance", verifyToken, requireAdmin, getTrialBalance);

export default router;
