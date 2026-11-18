import express from "express";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  listRequests,
  countRequests,
  approveRequest,
  declineRequest,
} from "../controllers/requestsController.js";

const router = express.Router();
router.get("/", verifyToken, requireAdmin, listRequests);
router.get("/count", verifyToken, requireAdmin, countRequests);
router.post("/:id/approve", verifyToken, requireAdmin, approveRequest);
router.post("/:id/decline", verifyToken, requireAdmin, declineRequest);

export default router;
