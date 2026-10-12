import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getMyCooperative,
  updateMyCooperative,
} from "../controllers/cooperativeController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getMyCooperative);
router.put("/", verifyToken, requireAdmin, updateMyCooperative);

export default router;
