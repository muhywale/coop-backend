import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  getProducts,
  createProduct,
  updateProduct,
  deactivateProduct,
} from "../controllers/productsController.js";

const router = express.Router();

router.get("/", verifyToken, getProducts);
router.post("/", verifyToken, requireAdmin, createProduct);

router.put("/:id", verifyToken, requireAdmin, updateProduct);
router.delete("/:id", verifyToken, requireAdmin, deactivateProduct);

export default router;
