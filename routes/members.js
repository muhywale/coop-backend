import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { body, validationResult } from "express-validator";

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

const validateMember = [
  body("full_name")
    .trim()
    .isLength({ min: 2 })
    .withMessage("Full name must be at least 2 characters"),
  body("email")
    .optional({ checkFalsy: true })
    .isEmail()
    .withMessage("Invalid email format"),
];

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/ledger", verifyToken, getMyLedger);
router.get("/me/detail", verifyToken, getMyDetail);
router.get("/me/transactions", verifyToken, getMyTransactions);
router.get("/me/accounts-ledger", verifyToken, getMyAccountsLedger);
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
router.get("/:id", verifyToken, getMemberById);
router.put("/:id", verifyToken, updateMember);
router.get("/", verifyToken, getMembers);

router.post(
  "/",
  verifyToken,
  requireAdmin,
  validateMember,
  handleValidation,
  createMember,
);

export default router;
