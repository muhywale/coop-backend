import express from "express";
import {
  getContributions,
  getContributionsByMember,
  createContribution,
  deleteContribution,
  getMemberBalance,
} from "../controllers/contributionsController.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

router.get("/", verifyToken, getContributions);
router.get("/member/:memberId", verifyToken, getContributionsByMember);
router.post("/", verifyToken, createContribution);
router.delete("/:id", verifyToken, deleteContribution);
router.get("/balance/:memberId", verifyToken, getMemberBalance);

export default router;
