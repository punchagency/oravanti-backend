import { Router } from "express";
import { forgotPassword, signIn, signUp } from "../controllers/auth.controller";

const router = Router();

router.post("/signup", signUp);
router.post("/signin", signIn);
router.post("/forgot-password", forgotPassword);

export default router;
