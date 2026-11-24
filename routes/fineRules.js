import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getFineRules,
  saveFineRules,
} from "../controllers/fineRulesController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getFineRules);
router.put("/", verifyToken, requireAdmin, saveFineRules);

export default router;
