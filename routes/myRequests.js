import express from "express";
import rateLimit from "express-rate-limit";
import { verifyToken } from "../middleware/auth.js";
import {
  createRequest,
  listMyRequests,
  cancelMyRequest,
} from "../controllers/requestsController.js";

// Answers only for the logged-in member, using the id from their login, never from the URL
const requireMemberAccount = (req, res, next) => {
  if (!req.user.memberId)
    return res
      .status(400)
      .json({ error: "This account isn't linked to a member" });
  next();
};

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `request-${req.user.userId}`,
  message: { error: "You've sent a lot of requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();
router.use(verifyToken, requireMemberAccount);

router.get("/", listMyRequests);
router.post("/", sendLimiter, createRequest);
router.post("/:id/cancel", cancelMyRequest);

export default router;
