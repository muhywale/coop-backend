import express from "express";
import rateLimit from "express-rate-limit";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { changeMyPassword } from "../controllers/passwordController.js";
import {
  requestPasswordReset,
  listResetRequests,
  countResetRequests,
  dismissResetRequest,
} from "../controllers/resetRequestController.js";

const FIFTEEN_MIN = 15 * 60 * 1000;

// Changing your own password: keyed by user, and only failed attempts count
const changeLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 10,
  keyGenerator: (req) => `user-${req.user.userId}`,
  skipSuccessfulRequests: true,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// "Forgot password": per username, plus a wider per-visitor cap
const forgotPerUsername = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 3,
  keyGenerator: (req) =>
    `forgot-${String(req.body?.username || "")
      .toLowerCase()
      .slice(0, 50)}`,
  message: {
    error: "Too many requests for this username. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
const forgotPerVisitor = rateLimit({
  windowMs: FIFTEEN_MIN,
  max: 30,
  message: { error: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();

router.post("/change", verifyToken, changeLimiter, changeMyPassword);

router.post(
  "/forgot",
  forgotPerVisitor,
  forgotPerUsername,
  requestPasswordReset,
);
router.get("/requests/count", verifyToken, requireAdmin, countResetRequests);
router.get("/requests", verifyToken, requireAdmin, listResetRequests);
router.post(
  "/requests/:id/dismiss",
  verifyToken,
  requireAdmin,
  dismissResetRequest,
);

export default router;
