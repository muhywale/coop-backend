import express from "express";
import { verifyToken } from "../middleware/auth.js";
import { getMySchedule } from "../controllers/scheduleController.js";
import {
  getSummary,
  getLoans,
  getStatement,
} from "../controllers/memberPortalController.js";

// Every route here answers only for the logged-in member, using the id from their login, never from the URL
const requireMemberAccount = (req, res, next) => {
  if (!req.user.memberId)
    return res
      .status(400)
      .json({ error: "This account isn't linked to a member" });
  next();
};

const router = express.Router();
router.use(verifyToken, requireMemberAccount);

router.get("/summary", getSummary);
router.get("/owing", getMySchedule);
router.get("/loans", getLoans);
router.get("/statement", getStatement);

export default router;
