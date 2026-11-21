import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  listActivity,
  listActivityUsers,
} from "../controllers/activityController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, listActivity);
router.get("/users", verifyToken, requireAdmin, listActivityUsers);

export default router;
