import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";
import { AuthenticationError } from "../errors/app-error";

export interface AuthRequest extends Request {
  userId?: string;
  accessToken?: string;
  adminId?: string;
  staffId?: string;
  firmId?: string;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthenticationError("Missing or invalid authorization header");
  }

  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new AuthenticationError("Invalid or expired token");
  }

  req.userId = data.user.id;
  req.accessToken = token;
  next();
};
