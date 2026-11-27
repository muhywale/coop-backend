import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getMemberProfile,
  updateMemberProfile,
  listMemberProfiles,
} from "../controllers/memberProfileController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, listMemberProfiles);
router.get("/:id", verifyToken, requireAdmin, getMemberProfile);
router.put("/:id", verifyToken, requireAdmin, updateMemberProfile);

export default router;
