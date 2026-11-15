import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  listNotices,
  createNotice,
  updateNotice,
  deleteNotice,
} from "../controllers/noticesController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, listNotices);
router.post("/", verifyToken, requireAdmin, createNotice);
router.put("/:id", verifyToken, requireAdmin, updateNotice);
router.delete("/:id", verifyToken, requireAdmin, deleteNotice);

export default router;
