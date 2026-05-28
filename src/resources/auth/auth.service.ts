import { supabase, supabaseAdmin } from "../../config/supabase";
import { db } from "../../db/client";
import { admins } from "../../db/schema/admins";
import { firms } from "../../db/schema/firm-info";
import {
  AppError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  InternalServerError,
  ValidationError,
} from "../../utils/error/app-error";

type AuthServiceError = {
  message: string;
  status?: number;
};

const mapAuthError = (error: AuthServiceError) => {
  switch (error.status) {
    case 400:
      return new BadRequestError(error.message);
    case 401:
      return new AuthenticationError(error.message);
    case 409:
      return new ConflictError(error.message);
    case 422:
      return new ValidationError(error.message);
    default:
      return new ExternalServiceError(error.message);
  }
};

export class AuthService {
  signUpAdmin = async (body: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    firmName: string;
    firmEmail: string;
    firmPhone?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    website?: string;
    taxId?: string;
  }) => {
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
      });

    if (authError) throw mapAuthError(authError);

    const userId = authData.user.id;

    try {
      const [firm] = await db
        .insert(firms)
        .values({
          firmName: body.firmName,
          firmEmail: body.firmEmail,
          firmPhone: body.firmPhone,
          address: body.address,
          city: body.city,
          state: body.state,
          zipCode: body.zipCode,
          website: body.website,
          taxId: body.taxId,
        })
        .returning();

      await db.insert(admins).values({
        userId,
        firmId: firm.id,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
      });

      const { data: sessionData, error: sessionError } =
        await supabase.auth.signInWithPassword({
          email: body.email,
          password: body.password,
        });

      if (sessionError) throw mapAuthError(sessionError);

      return { session: sessionData.session, user: sessionData.user, firm };
    } catch (err) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      if (err instanceof AppError) throw err;
      throw new InternalServerError((err as Error).message);
    }
  };

  signInAdmin = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw new AuthenticationError(error.message);

    return data;
  };

  sendPasswordResetEmail = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "http://localhost:3000/reset-password",
    });

    if (error) throw mapAuthError(error);
  };
}
