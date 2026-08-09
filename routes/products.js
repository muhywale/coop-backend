import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getProducts,
  createProduct,
} from "../controllers/productsController.js";

const router = express.Router();

router.get("/", verifyToken, getProducts);
router.post("/", verifyToken, requireAdmin, createProduct);

export default router;
