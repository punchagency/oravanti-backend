import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";
import { withSpan } from "../../telemetry/span";
import { ExternalServiceError } from "../error/app-error";
import { BaseStorageService, type UploadObjectOptions } from "./storage.types";

/**
 * Cloudflare R2 implementation of {@link BaseStorageService}. R2 is
 * S3-compatible, so we drive it with the AWS S3 SDK pointed at the account's
 * R2 endpoint.
 *
 * Every call is wrapped in a span. Object storage is the slowest dependency in
 * most document requests and the one most likely to be the reason a request is
 * slow, but nothing instruments it: the OTel HTTP instrumentation does not see
 * inside the AWS SDK's own client. Without these, a 4-second upload shows up
 * on a trace as 4 seconds of unexplained gap.
 *
 * Attributes follow the OTel semantic conventions for object stores, so the
 * spans are readable in any backend rather than only against dashboards built
 * for this codebase. The object key is recorded; its contents never are.
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
      // Newer aws-sdk versions append `x-amz-checksum-mode=ENABLED` to
      // GetObject by default; Cloudflare R2 rejects that header (403), so
      // only compute checksums when the API explicitly requires them.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  upload = async ({ key, body, contentType }: UploadObjectOptions) =>
    withSpan(
      "r2.upload",
      async () => {
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
          throw new ExternalServiceError(
            toMessage(error, "Failed to upload file"),
          );
        }
      },
      this.spanAttributes(key, "PutObject"),
    );

  getSignedDownloadUrl = async (
    key: string,
    expiresInSeconds = BaseStorageService.DEFAULT_DOWNLOAD_EXPIRY_SECONDS,
  ) =>
    withSpan(
      "r2.sign_download_url",
      async () => {
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
      },
      this.spanAttributes(key, "GetObject"),
    );

  download = async (key: string) =>
    withSpan(
      "r2.download",
      async (span) => {
        try {
          const { Body } = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          );
          if (!Body) throw new Error("Empty object body");
          const bytes = Buffer.from(await Body.transformToByteArray());
          // Recorded after the read: how much was transferred is usually the
          // explanation for how long it took.
          span.setAttribute("http.response.body.size", bytes.byteLength);
          return bytes;
        } catch (error) {
          throw new ExternalServiceError(
            toMessage(error, "Failed to read file"),
          );
        }
      },
      this.spanAttributes(key, "GetObject"),
    );

  remove = async (keys: string[]) => {
    if (!keys.length) return;
    await withSpan(
      "r2.delete",
      async () => {
        try {
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
        } catch (error) {
          throw new ExternalServiceError(
            toMessage(error, "Failed to delete file"),
          );
        }
      },
      {
        "cloud.provider": "cloudflare",
        "aws.s3.bucket": this.bucket,
        "aws.s3.key_count": keys.length,
        "rpc.method": "DeleteObjects",
      },
    );
  };

  /** Shared attributes. The key identifies the object; the bytes never leave. */
  private spanAttributes = (key: string, operation: string) => ({
    "cloud.provider": "cloudflare",
    "aws.s3.bucket": this.bucket,
    "aws.s3.key": key,
    "rpc.method": operation,
  });
}

const toMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
