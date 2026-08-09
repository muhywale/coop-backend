import express from "express";
import { verifyToken } from "../middleware/auth.js";
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
} from "../controllers/membersController.js";

const router = express.Router();

router.get("/", getMembers);
router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/ledger", verifyToken, getMyLedger);
router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/transactions", verifyToken, getMyTransactions);
router.get("/:id", getMemberById);
router.post("/", createMember);
router.put("/:id", updateMember);
router.delete("/:id", deleteMember);
router.get("/:id/detail", getMemberDetail);
router.get("/:id/transactions", verifyToken, getMemberTransactions);
router.get("/:id/ledger", getMemberLedgerByProduct);

export default router;
