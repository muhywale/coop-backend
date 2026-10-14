import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { recordBulkPayments } from "../controllers/bulkPaymentController.js";

const router = express.Router();
router.post("/", verifyToken, requireAdmin, recordBulkPayments);

export default router;
