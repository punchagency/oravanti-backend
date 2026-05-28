import { Router } from "express";
import { AuthController } from "./auth.controller";

export class AuthRouter {
  public router: Router;
  public path: string;
  private authController: AuthController;

  constructor(authController: AuthController) {
    this.router = Router();
    this.path = "/auth";
    this.authController = authController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.post("/signup", this.authController.signUp);
    this.router.post("/signin", this.authController.signIn);
    this.router.post("/forgot-password", this.authController.forgotPassword);
  }
}
