import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  listRequests,
  countRequests,
  approveRequest,
  declineRequest,
  completeRequest,
} from "../controllers/requestsController.js";
import {
  getRequestRules,
  saveRequestRules,
} from "../controllers/requestRulesController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, listRequests);
router.get("/count", verifyToken, requireAdmin, countRequests);
router.get("/rules", verifyToken, requireAdmin, getRequestRules);
router.put("/rules", verifyToken, requireAdmin, saveRequestRules);
router.post("/:id/approve", verifyToken, requireAdmin, approveRequest);
router.post("/:id/decline", verifyToken, requireAdmin, declineRequest);
router.post("/:id/complete", verifyToken, requireAdmin, completeRequest);

export default router;
