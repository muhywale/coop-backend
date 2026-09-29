import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getLoans,
  getLoansByMember,
  createLoan,
  recordRepayment,
  getRepayments,
  getLoansByMemberId,
  runInterestAccrual,
  getLoanPerformanceReport,
  editLoan,
  deleteLoan,
} from "../controllers/loansController.js";

const router = express.Router();

router.get("/", verifyToken, requireAdmin, getLoans); // only admin sees ALL loans
router.get("/mine", verifyToken, getLoansByMember); // member sees only their own
router.post("/", verifyToken, requireAdmin, createLoan);
router.post("/:loanId/repayments", verifyToken, recordRepayment);
router.get("/:loanId/repayments", verifyToken, getRepayments);
router.get("/member/:memberId", verifyToken, requireAdmin, getLoansByMemberId);
router.post(
  "/run-interest-accrual",
  verifyToken,
  requireAdmin,
  runInterestAccrual,
);
router.get(
  "/performance-report",
  verifyToken,
  requireAdmin,
  getLoanPerformanceReport,
);
router.put("/:id/edit", verifyToken, requireAdmin, editLoan);
router.delete("/:id", verifyToken, requireAdmin, deleteLoan);

export default router;
