import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  distributePayment,
  withdrawFunds,
} from "../controllers/paymentsController.js";

const router = express.Router();
router.post("/distribute", verifyToken, requireAdmin, distributePayment);
router.post("/withdraw", verifyToken, requireAdmin, withdrawFunds);

export default router;
