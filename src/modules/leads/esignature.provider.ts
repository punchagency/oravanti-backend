import { randomUUID } from "crypto";
import { env } from "../../config/env";

/** Which party a signer is. Also the PDF text-tag role: signer1 / signer2. */
export type ESignatureSignerRole = "client" | "firm";

export interface ESignatureSigner {
  email: string;
  name: string;
  role: ESignatureSignerRole;
  /**
   * Signing position. Distinct positions make the provider enforce the
   * sequence: a signer's sign URL is not released until every lower order has
   * signed. That enforcement is the whole guarantee behind "the firm
   * counter-signs what the client accepted" — nothing in our code polices it.
   */
  order: number;
}

export interface CreateEmbeddedRequestInput {
  /** One entry for a client-only agreement, two when the firm counter-signs. */
  signers: ESignatureSigner[];
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
  /**
   * signature_id per role → fee_agreements.signerSignatureId /
   * firmSignerSignatureId. Keyed by role rather than positional because the
   * order the two are sent in is a firm setting, and a positional result would
   * silently swap the client's and the firm's identifiers when a firm chose
   * firm-first.
   */
  signatureIds: Partial<Record<ESignatureSignerRole, string>>;
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
  /**
   * Withdraw an incomplete signature request. Used when the firm signer is
   * reassigned: the document names them, so the outstanding request is void and
   * a fresh one takes its place.
   */
  cancelSignatureRequest(signatureRequestId: string): Promise<void>;
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
    input: CreateEmbeddedRequestInput,
  ): Promise<CreateEmbeddedRequestResult> {
    const signatureIds: CreateEmbeddedRequestResult["signatureIds"] = {};
    for (const signer of input.signers) signatureIds[signer.role] = randomUUID();
    return { signatureRequestId: randomUUID(), signatureIds };
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

  async cancelSignatureRequest(_signatureRequestId: string): Promise<void> {
    // Nothing to withdraw — the stub never created anything at a provider.
  }
}

export const stubESignatureProvider = new StubESignatureProvider();
