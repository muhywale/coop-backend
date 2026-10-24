import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getAccountStatement,
  getMemberStatement,
  getMyStatement,
} from "../controllers/statementController.js";

const router = express.Router();
router.get(
  "/account/:accountId",
  verifyToken,
  requireAdmin,
  getAccountStatement,
);
router.get("/member/:memberId", verifyToken, requireAdmin, getMemberStatement);
router.get("/me", verifyToken, getMyStatement);

export default router;
