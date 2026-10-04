import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getChartOfAccounts,
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  deleteAccount,
} from "../controllers/chartOfAccountsController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getChartOfAccounts);
router.post("/", verifyToken, requireAdmin, createAccount);
router.put("/:id", verifyToken, requireAdmin, updateAccount);
router.put("/:id/deactivate", verifyToken, requireAdmin, deactivateAccount);
router.put("/:id/reactivate", verifyToken, requireAdmin, reactivateAccount);
router.delete("/:id", verifyToken, requireAdmin, deleteAccount);

export default router;
