export type UploadObjectOptions = {
  /** Full object key within the bucket (e.g. "avatars/123.png"). */
  key: string;
  body: Buffer;
  contentType: string;
};

/**
 * Storage backend contract. Implementations persist file objects to a single
 * bucket; callers address objects by key (path-builder helpers in the consuming
 * services produce these keys). Files are kept private — readable URLs are
 * short-lived presigned URLs generated on demand via `getSignedDownloadUrl`.
 */
export abstract class BaseStorageService {
  /** Default presigned download URL lifetime, in seconds. */
  static readonly DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

  abstract upload(options: UploadObjectOptions): Promise<void>;

  abstract getSignedDownloadUrl(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  abstract download(key: string): Promise<Buffer>;

  abstract remove(keys: string[]): Promise<void>;
}
