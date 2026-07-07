import { randomUUID } from "crypto";
import { env } from "../../config/env";

export interface ESignatureSigner {
  email: string;
  name: string;
}

export interface CreateEmbeddedRequestInput {
  signer: ESignatureSigner;
  /** The generated (unsigned) fee-agreement PDF. */
  file: Buffer;
  fileName: string;
  title: string;
  subject: string;
  metadata: { agreementId: string; leadId: string; organizationId: string };
  testMode: boolean;
}

export interface CreateEmbeddedRequestResult {
  /** Dropbox Sign signature_request_id → fee_agreements.envelopeId. */
  signatureRequestId: string;
  /** The client signer's signature_id → fee_agreements.signerSignatureId. */
  signerSignatureId: string;
}

export interface EmbeddedSignUrl {
  signUrl: string;
  /** Unix seconds when the sign URL expires (~60 min out). */
  expiresAt: number;
}

/**
 * Contract for the e-signature backend used by the fee-agreement flow. The
 * embedded-signing methods let the client sign inside Oravanti via an iframe
 * (Dropbox Sign JS SDK); the webhook is the authoritative completion signal.
 */
export interface ESignatureProvider {
  createEmbeddedRequest(
    input: CreateEmbeddedRequestInput,
  ): Promise<CreateEmbeddedRequestResult>;
  /** Minted fresh on demand — sign URLs are short-lived and must not be cached. */
  getEmbeddedSignUrl(signatureId: string): Promise<EmbeddedSignUrl>;
  /** The completed, signed PDF for archival once all parties have signed. */
  downloadSignedPdf(signatureRequestId: string): Promise<Buffer>;
  /** Verify a webhook callback's authenticity (HMAC over event fields). */
  verifyWebhook(eventTime: string, eventType: string, eventHash: string): boolean;
}

const stubBaseUrl = () =>
  process.env.APP_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:3000";

/**
 * Local-dev fallback used when no Dropbox Sign credentials are configured.
 * Produces deterministic fake identifiers and a stub signing URL so the whole
 * fee-agreement flow works end-to-end without an external account.
 */
export class StubESignatureProvider implements ESignatureProvider {
  async createEmbeddedRequest(
    _input: CreateEmbeddedRequestInput,
  ): Promise<CreateEmbeddedRequestResult> {
    return {
      signatureRequestId: randomUUID(),
      signerSignatureId: randomUUID(),
    };
  }

  async getEmbeddedSignUrl(signatureId: string): Promise<EmbeddedSignUrl> {
    return {
      signUrl: `${stubBaseUrl()}/api/stubs/esignature/sign/${signatureId}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  async downloadSignedPdf(_signatureRequestId: string): Promise<Buffer> {
    // Minimal valid single-page PDF so archival paths don't choke in dev.
    return Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
        "trailer<</Root 1 0 R>>\n%%EOF",
      "latin1",
    );
  }

  verifyWebhook(): boolean {
    return true;
  }
}

export const stubESignatureProvider = new StubESignatureProvider();
