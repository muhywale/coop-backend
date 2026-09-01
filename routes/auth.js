import express from "express";
import { body, validationResult } from "express-validator";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import {
  login,
  createMemberLogin,
  changePassword,
} from "../controllers/authController.js";

const router = express.Router();

const validateLogin = [
  body("username").trim().notEmpty().withMessage("Username is required"),
  body("password").notEmpty().withMessage("Password is required"),
];

export const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

export const logout = (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
};

router.post("/login", validateLogin, handleValidation, login);
router.post("/create-login", verifyToken, requireAdmin, createMemberLogin);
router.post("/change-password", verifyToken, changePassword);
router.post("/logout", logout);

export default router;
