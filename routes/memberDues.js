import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getMemberDues,
  saveMemberDues,
} from "../controllers/memberDuesController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getMemberDues);
router.put("/", verifyToken, requireAdmin, saveMemberDues);

export default router;
