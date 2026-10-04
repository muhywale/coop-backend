import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { getPaymentSchedule } from "../controllers/scheduleController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getPaymentSchedule);

export default router;
