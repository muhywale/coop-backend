import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { exportBackup } from "../controllers/backupController.js";

const router = express.Router();
router.get("/export", verifyToken, requireAdmin, exportBackup);

export default router;
