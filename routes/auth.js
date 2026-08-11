import express from "express";
import {
  login,
  createMemberLogin,
  changePassword,
} from "../controllers/authController.js";

import { verifyToken, requireAdmin } from "../middleware/auth.js";
const router = express.Router();

router.post("/create-login", verifyToken, requireAdmin, createMemberLogin);
router.post("/change-password", verifyToken, changePassword);
router.post("/login", login);

export default router;
