import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  distributePayment,
  withdrawFunds,
  correctContribution,
} from "../controllers/paymentsController.js";

const router = express.Router();
router.post("/distribute", verifyToken, requireAdmin, distributePayment);
router.post("/withdraw", verifyToken, requireAdmin, withdrawFunds);

router.delete(
  "/contributions/:id/correct",
  verifyToken,
  requireAdmin,
  correctContribution,
);

export default router;
