import express from "express";
import { verifyToken, requireSuperAdmin } from "../middleware/auth.js";
import {
  createCooperative,
  getCooperatives,
} from "../controllers/superAdminController.js";
import {
  listCooperativeAdmins,
  countPlatformResetRequests,
  resetCooperativeAdminPassword,
  dismissAdminRequest,
} from "../controllers/superAdminPasswordController.js";

const router = express.Router();

router.post("/cooperatives", verifyToken, requireSuperAdmin, createCooperative);
router.get("/cooperatives", verifyToken, requireSuperAdmin, getCooperatives);

router.get("/admins", verifyToken, requireSuperAdmin, listCooperativeAdmins);
router.get(
  "/reset-requests/count",
  verifyToken,
  requireSuperAdmin,
  countPlatformResetRequests,
);
router.put(
  "/users/:userId/reset-password",
  verifyToken,
  requireSuperAdmin,
  resetCooperativeAdminPassword,
);
router.post(
  "/users/:userId/dismiss-request",
  verifyToken,
  requireSuperAdmin,
  dismissAdminRequest,
);

export default router;
