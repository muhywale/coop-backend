import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getLoanFormFees,
  saveLoanFormFees,
} from "../controllers/loanFormFeeController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getLoanFormFees);
router.put("/", verifyToken, requireAdmin, saveLoanFormFees);

export default router;
