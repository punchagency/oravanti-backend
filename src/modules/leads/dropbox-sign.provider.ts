import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import { ExternalServiceError } from "../../utils/error/app-error";
import {
  stubESignatureProvider,
  type CreateEmbeddedRequestInput,
  type CreateEmbeddedRequestResult,
  type EmbeddedSignUrl,
  type ESignatureProvider,
} from "./esignature.provider";

const API_BASE = "https://api.hellosign.com/v3";

/**
 * Dropbox Sign (formerly HelloSign) provider implemented directly against the
 * v3 REST API (no SDK dependency). Uses the platform-owned API key + API App
 * client id for embedded signing. Auth is HTTP Basic with the API key as the
 * username and an empty password.
 */
export class DropboxSignProvider implements ESignatureProvider {
  constructor(
    private readonly apiKey: string,
    private readonly clientId: string,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
  }

  async createEmbeddedRequest(
    input: CreateEmbeddedRequestInput,
  ): Promise<CreateEmbeddedRequestResult> {
    const form = new FormData();
    form.append("client_id", this.clientId);
    form.append("title", input.title);
    form.append("subject", input.subject);
    // Sent in `order`, so the array index and the signing position agree — the
    // text tags in the PDF are numbered by position (`signer1`, `signer2`), and
    // Dropbox Sign matches a tag to the signer at that index.
    const signers = [...input.signers].sort((a, b) => a.order - b.order);
    signers.forEach((signer, index) => {
      form.append(`signers[${index}][email_address]`, signer.email);
      form.append(`signers[${index}][name]`, signer.name);
      form.append(`signers[${index}][order]`, String(signer.order));
    });
    form.append("use_text_tags", "1");
    form.append("hide_text_tags", "1");
    form.append("test_mode", input.testMode ? "1" : "0");
    for (const [key, value] of Object.entries(input.metadata)) {
      form.append(`metadata[${key}]`, value);
    }
    form.append(
      "file[0]",
      new Blob([new Uint8Array(input.file)], { type: "application/pdf" }),
      input.fileName,
    );

    const json = await this.request<{
      signature_request: {
        signature_request_id: string;
        signatures: { signature_id: string }[];
      };
    }>("/signature_request/create_embedded", { method: "POST", body: form });

    const sr = json.signature_request;
    // `signatures` comes back in the order the signers were sent, which is the
    // order they were sorted into above — so index i is `signers[i]`, and the
    // role mapping survives a firm that signs first.
    const signatureIds: CreateEmbeddedRequestResult["signatureIds"] = {};
    signers.forEach((signer, index) => {
      const id = sr.signatures?.[index]?.signature_id;
      if (id) signatureIds[signer.role] = id;
    });

    const missing = signers.some((signer) => !signatureIds[signer.role]);
    if (!sr.signature_request_id || missing) {
      throw new ExternalServiceError(
        "Dropbox Sign returned an incomplete signature request",
      );
    }
    return { signatureRequestId: sr.signature_request_id, signatureIds };
  }

  async getEmbeddedSignUrl(signatureId: string): Promise<EmbeddedSignUrl> {
    const json = await this.request<{
      embedded: { sign_url: string; expires_at: number };
    }>(`/embedded/sign_url/${signatureId}`, { method: "GET" });
    return {
      signUrl: json.embedded.sign_url,
      expiresAt: json.embedded.expires_at,
    };
  }

  async downloadSignedPdf(signatureRequestId: string): Promise<Buffer> {
    const res = await fetch(
      `${API_BASE}/signature_request/files/${signatureRequestId}?file_type=pdf`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!res.ok) {
      throw new ExternalServiceError(
        `Dropbox Sign file download failed (${res.status})`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  verifyWebhook(
    eventTime: string,
    eventType: string,
    eventHash: string,
  ): boolean {
    // Dropbox Sign signs each event with HMAC-SHA256(event_time + event_type)
    // keyed by the account API key.
    const expected = createHmac("sha256", this.apiKey)
      .update(eventTime + eventType)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(eventHash ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async cancelSignatureRequest(signatureRequestId: string): Promise<void> {
    // Returns 200 with an empty body rather than JSON, so it does not go
    // through `request()`.
    const res = await fetch(
      `${API_BASE}/signature_request/cancel/${signatureRequestId}`,
      { method: "POST", headers: { Authorization: this.authHeader() } },
    );
    // 404 means it is already gone, and 409 that it is already complete —
    // either way there is nothing left to withdraw, which is what the caller
    // wanted. Only a real failure should stop a reassignment.
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      throw new ExternalServiceError(
        `Dropbox Sign cancel failed (${res.status})`,
      );
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { Authorization: this.authHeader(), ...(init.headers ?? {}) },
      });
    } catch (err) {
      throw new ExternalServiceError(
        `Dropbox Sign request failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ExternalServiceError(
        `Dropbox Sign API error (${res.status}): ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}

let cached: ESignatureProvider | null = null;

/**
 * Returns the Dropbox Sign provider when platform credentials are configured,
 * otherwise the stub. Import from here rather than constructing directly so the
 * fallback is consistent across the module.
 */
export const getESignatureProvider = (): ESignatureProvider => {
  if (cached) return cached;
  const { DROPBOX_SIGN_API_KEY, DROPBOX_SIGN_CLIENT_ID } = env;
  cached =
    DROPBOX_SIGN_API_KEY && DROPBOX_SIGN_CLIENT_ID
      ? new DropboxSignProvider(DROPBOX_SIGN_API_KEY, DROPBOX_SIGN_CLIENT_ID)
      : stubESignatureProvider;
  return cached;
};

/** True when real Dropbox Sign credentials are configured (not the stub). */
export const isDropboxSignConfigured = (): boolean =>
  Boolean(env.DROPBOX_SIGN_API_KEY && env.DROPBOX_SIGN_CLIENT_ID);
