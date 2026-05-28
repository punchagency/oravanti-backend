import { eq } from "drizzle-orm";
import { supabase } from "../../../config/supabase";
import { db } from "../../../db/client";
import { profiles } from "../../../db/schema";
import { ExternalServiceError } from "../../../errors/app-error";
import { UpdateProfileBody } from "../../../types/settings.types";
import { ExternalServiceError } from "../../../utils/error/app-error";

export class ProfileService {
  getProfile = async (userId: string) => {
    const result = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return result[0] ?? null;
  };

  upsertProfile = async (
    userId: string,
    body: UpdateProfileBody & { email?: string },
  ) => {
    const existing = await this.getProfile(userId);

    if (existing) {
      const [updated] = await db
        .update(profiles)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(profiles.userId, userId))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(profiles)
      .values({ userId, firstName: "", lastName: "", email: "", ...body })
      .returning();
    return created;
  };

  uploadAvatar = async (userId: string, file: Express.Multer.File) => {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `${userId}.${fileExt}`;

    const { error } = await supabase.storage
      .from("avatars")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) throw new ExternalServiceError(error.message);

    const { data } = supabase.storage.from("avatars").getPublicUrl(fileName);

    const [updated] = await db
      .update(profiles)
      .set({ avatarUrl: data.publicUrl, updatedAt: new Date() })
      .where(eq(profiles.userId, userId))
      .returning();

    return updated;
  };
}
