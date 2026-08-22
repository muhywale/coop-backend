import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  getMemberDetail,
  getMyDetail,
  getMemberTransactions,
  getMyTransactions,
  getMemberLedgerByProduct,
  getMyLedger,
  getMyAccountsLedger,
  getMemberAccountsLedger,
} from "../controllers/membersController.js";

const router = express.Router();

router.get("/", verifyToken, getMembers);
router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/ledger", verifyToken, getMyLedger);
router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/transactions", verifyToken, getMyTransactions);
router.get("/:id", verifyToken, getMemberById);
router.post("/", verifyToken, createMember);
router.put("/:id", verifyToken, updateMember);
router.delete("/:id", verifyToken, deleteMember);
router.get("/:id/detail", verifyToken, getMemberDetail);
router.get("/:id/transactions", verifyToken, getMemberTransactions);
router.get("/:id/ledger", verifyToken, getMemberLedgerByProduct);
router.get(
  "/:id/accounts-ledger",
  verifyToken,
  requireAdmin,
  getMemberAccountsLedger,
);
router.get("/me/accounts-ledger", verifyToken, getMyAccountsLedger);

export default router;
