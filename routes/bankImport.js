import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  matchBankList,
  importBankLoans,
} from "../controllers/bankImportController.js";

const router = express.Router();
router.post("/match", verifyToken, requireAdmin, matchBankList);
router.post("/loans", verifyToken, requireAdmin, importBankLoans);

export default router;
