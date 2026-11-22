import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { getYearEndReport } from "../controllers/yearEndController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getYearEndReport);

export default router;
