import { Request, Response } from "express";
import { SignInBody } from "../../types/auth.types";
import { applyAuthHeaders } from "../../utils/applyAuthHeaders";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError } from "../../utils/error/app-error";
import { AuthService } from "./auth.service";

export class AuthController {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  signUpWithEmail = asyncWrap(
    async (
      req: Request<
        {},
        {},
        { email: string; password: string; rememberMe?: boolean }
      >,
      res: Response,
    ) => {
      const { email, password, rememberMe = false } = req.body;

      if (!email || !password) {
        throw new BadRequestError("Email and password are required");
      }

      const authResponse = await this.authService.signUpWithEmail(
        req.body,
        req,
      );

      applyAuthHeaders(authResponse.headers, res);

      const data = await authResponse.json();

      res.status(200).json({
        message: data.message || "Signup successful",
        success: true,
        data,
      });
    },
  );

  signInWithEmail = asyncWrap(
    async (req: Request<{}, {}, SignInBody>, res: Response) => {
      const { email, password } = req.body;

      if (!email || !password) {
        throw new BadRequestError("Email and password are required");
      }

      const authResponse = await this.authService.signInWithEmail(
        email,
        password,
        req,
      );

      applyAuthHeaders(authResponse.headers, res);

      const data = await authResponse.json();

      res.status(200).json({
        message: "Sign in successful",
        success: true,

        data,
      });
    },
  );

  verifyTOTP = asyncWrap(async (req: Request, res: Response) => {
    const { code } = req.body;

    if (!code) {
      throw new BadRequestError("Code is required");
    }

    const authResponse = await this.authService.verifyTOTP(code, req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();

    res.status(200).json({
      message: "Sign in successful",
      success: true,

      data,
    });
  });
}
