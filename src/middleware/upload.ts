import multer from "multer";
import { BadRequestError } from "../utils/error/app-error";

/**
 * Upload configuration lives here, not in route files.
 *
 * `multer.memoryStorage()` buffers the entire request body into the Node heap
 * before the handler runs. Without an explicit `limits.fileSize` a single
 * request can exhaust available memory and take the process down — which, with
 * no clustering, takes every in-flight request with it. Every multer instance
 * in this codebase must therefore carry a size limit and a type allowlist.
 *
 * Use one of the presets below. If a route needs something else, add a preset
 * here rather than calling `multer()` in a route file.
 */

export const MB = 1024 * 1024;

/** Re-exported so route files never need to import multer themselves. */
export type Upload = multer.Multer;

/** Images used as avatars and logos. */
export const IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Documents a firm or a client submits into a matter. */
export const DOCUMENT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  ...IMAGE_MIME,
] as const;

export interface UploadOptions {
  /** Per-file ceiling in bytes. */
  maxBytes: number;
  /** Accepted MIME types. */
  mime: readonly string[];
  /** Maximum files in one request. */
  maxFiles?: number;
}

/**
 * Builds a multer instance with a size limit and a type allowlist.
 *
 * Rejections are thrown as `BadRequestError` so they travel the normal error
 * pipeline; multer's own `LIMIT_FILE_SIZE` is caught by `error.middleware.ts`
 * and mapped to 413.
 */
export const createUpload = ({ maxBytes, mime, maxFiles = 10 }: UploadOptions) =>
  multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: maxFiles,
      fields: 50,
      // Guards `upload.none()` routes, where the body is multipart form fields
      // rather than files and `fileSize` therefore never applies.
      fieldSize: 1 * MB,
    },
    fileFilter: (_req, file, cb) => {
      if (mime.includes(file.mimetype)) {
        cb(null, true);
        return;
      }
      cb(
        new BadRequestError(
          `Unsupported file type: ${file.mimetype}. Accepted: ${mime.join(", ")}`,
        ),
      );
    },
  });

/** Avatars, firm logos, profile images. */
export const imageUpload = (maxBytes = 5 * MB) =>
  createUpload({ maxBytes, mime: IMAGE_MIME, maxFiles: 1 });

/** Matter documents, questionnaire attachments, contractor certifications. */
export const documentUpload = (maxBytes = 25 * MB, maxFiles = 10) =>
  createUpload({ maxBytes, mime: DOCUMENT_MIME, maxFiles });

/**
 * Multipart requests that carry no files at all — used with `.none()`.
 * Still bounded, so a multipart body cannot be used to exhaust memory.
 */
export const fieldsOnlyUpload = () =>
  multer({
    storage: multer.memoryStorage(),
    limits: { files: 0, fields: 50, fieldSize: 1 * MB },
  });
