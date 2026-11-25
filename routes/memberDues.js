import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getMemberDues,
  saveMemberDues,
  saveDueSeason,
} from "../controllers/memberDuesController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getMemberDues);
router.put("/", verifyToken, requireAdmin, saveMemberDues);
router.put("/season", verifyToken, requireAdmin, saveDueSeason);

export default router;
