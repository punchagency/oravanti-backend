import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { profiles } from "../../../db/schema";
import { UpdateProfileBody } from "../../../types/settings.types";
import { storageService } from "../../../utils/storage/storage.service";

type ProfileRow = typeof profiles.$inferSelect;

export class ProfileService {
  // The avatarUrl column holds the storage object key; expose a short-lived
  // presigned download URL to callers instead of the raw key.
  private withSignedAvatar = async (
    profile: ProfileRow | null,
  ): Promise<ProfileRow | null> => {
    if (!profile?.avatarUrl) return profile;
    return {
      ...profile,
      avatarUrl: await storageService.getSignedDownloadUrl(profile.avatarUrl),
    };
  };

  getProfile = async (userId: string) => {
    const result = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return this.withSignedAvatar(result[0] ?? null);
  };

  upsertProfile = async (
    userId: string,
    body: UpdateProfileBody & { email?: string },
  ) => {
    const [existing] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));

    if (existing) {
      const [updated] = await db
        .update(profiles)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(profiles.userId, userId))
        .returning();
      return this.withSignedAvatar(updated);
    }

    const [created] = await db
      .insert(profiles)
      .values({ userId, firstName: "", lastName: "", email: "", ...body })
      .returning();
    return this.withSignedAvatar(created);
  };

  uploadAvatar = async (userId: string, file: Express.Multer.File) => {
    const fileExt = file.originalname.split(".").pop();
    const key = `avatars/${userId}.${fileExt}`;

    await storageService.upload({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    const [updated] = await db
      .update(profiles)
      .set({ avatarUrl: key, updatedAt: new Date() })
      .where(eq(profiles.userId, userId))
      .returning();

    return this.withSignedAvatar(updated);
  };
}
