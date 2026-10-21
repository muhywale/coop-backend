import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getUsers,
  createUser,
  updateUserRole,
  resetUserPassword,
  deleteUser,
} from "../controllers/usersController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, getUsers);
router.post("/", verifyToken, requireAdmin, createUser);
router.put("/:id/role", verifyToken, requireAdmin, updateUserRole);
router.put("/:id/reset-password", verifyToken, requireAdmin, resetUserPassword);
router.delete("/:id", verifyToken, requireAdmin, deleteUser);

export default router;
