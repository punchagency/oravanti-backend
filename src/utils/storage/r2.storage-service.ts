import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";
import { ExternalServiceError } from "../error/app-error";
import { BaseStorageService, type UploadObjectOptions } from "./storage.types";

/**
 * Cloudflare R2 implementation of {@link BaseStorageService}. R2 is
 * S3-compatible, so we drive it with the AWS S3 SDK pointed at the account's
 * R2 endpoint.
 */
export class R2StorageService extends BaseStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    super();
    this.bucket = env.R2_BUCKET;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  upload = async ({ key, body, contentType }: UploadObjectOptions) => {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      throw new ExternalServiceError(toMessage(error, "Failed to upload file"));
    }
  };

  getSignedDownloadUrl = async (
    key: string,
    expiresInSeconds = BaseStorageService.DEFAULT_DOWNLOAD_EXPIRY_SECONDS,
  ) => {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      throw new ExternalServiceError(
        toMessage(error, "Failed to generate download URL"),
      );
    }
  };

  download = async (key: string) => {
    try {
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!Body) throw new Error("Empty object body");
      return Buffer.from(await Body.transformToByteArray());
    } catch (error) {
      throw new ExternalServiceError(toMessage(error, "Failed to read file"));
    }
  };

  remove = async (keys: string[]) => {
    if (!keys.length) return;
    try {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    } catch (error) {
      throw new ExternalServiceError(toMessage(error, "Failed to delete file"));
    }
  };
}

const toMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
