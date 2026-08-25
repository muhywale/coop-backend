import express from "express";
import { verifyToken, requireSuperAdmin } from "../middleware/auth.js";
import {
  createCooperative,
  getCooperatives,
} from "../controllers/superAdminController.js";

const router = express.Router();

router.post("/cooperatives", verifyToken, requireSuperAdmin, createCooperative);
router.get("/cooperatives", verifyToken, requireSuperAdmin, getCooperatives);

export default router;
