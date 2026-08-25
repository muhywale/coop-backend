import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getChartOfAccounts,
  createAccount,
  updateAccount,
  deactivateAccount,
} from "../controllers/chartOfAccountsController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getChartOfAccounts);
router.post("/", verifyToken, requireAdmin, createAccount);
router.put("/:id", verifyToken, requireAdmin, updateAccount);
router.delete("/:id", verifyToken, requireAdmin, deactivateAccount);

export default router;
