import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { distributePayment } from "../controllers/paymentsController.js";

const router = express.Router();
router.post("/distribute", verifyToken, requireAdmin, distributePayment);

export default router;
