import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getAccountCarryForward,
  saveAccountCarryForward,
  getMemberCarryForward,
  saveMemberCarryForward,
} from "../controllers/carryForwardController.js";

const router = express.Router();
router.get("/accounts", verifyToken, requireAdmin, getAccountCarryForward);
router.put("/accounts", verifyToken, requireAdmin, saveAccountCarryForward);
router.get("/members", verifyToken, requireAdmin, getMemberCarryForward);
router.put("/members", verifyToken, requireAdmin, saveMemberCarryForward);

export default router;
