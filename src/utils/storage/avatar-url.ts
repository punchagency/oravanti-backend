import { storageService } from "./storage.service";

/**
 * Resolves a stored avatar value into a fresh, short-lived signed download
 * URL. The DB must store the R2 *key* (e.g. "avatars/<id>.jpeg"); a signed
 * URL persisted at upload time expires after an hour and then 403s on the
 * browser's direct fetch against R2. Legacy rows holding a full presigned
 * URL are unwrapped back to their key on read so they self-heal.
 */
export async function resolveAvatarUrl(
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  const key = toR2Key(stored);
  if (!key) return null;
  return storageService.getSignedDownloadUrl(key);
}

function toR2Key(stored: string): string | null {
  if (stored.includes("r2.cloudflarestorage.com")) {
    try {
      return decodeURIComponent(new URL(stored).pathname).replace(/^\//, "");
    } catch {
      return null;
    }
  }
  return stored;
}
