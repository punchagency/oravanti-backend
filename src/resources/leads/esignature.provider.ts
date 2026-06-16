import { randomUUID } from "crypto";
import { env } from "../../config/env";

export interface ESignatureEnvelope {
  envelopeId: string;
  signingLink: string;
}

export interface ESignatureProvider {
  createEnvelope(recipientEmail: string, documentContent: string): Promise<ESignatureEnvelope>;
}

export class StubESignatureProvider implements ESignatureProvider {
  async createEnvelope(recipientEmail: string, _documentContent: string): Promise<ESignatureEnvelope> {
    const envelopeId = randomUUID();
    const baseUrl = process.env.APP_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const signingLink = `${baseUrl}/api/stubs/esignature/sign/${envelopeId}?email=${encodeURIComponent(recipientEmail)}`;
    return { envelopeId, signingLink };
  }
}

export const stubESignatureProvider = new StubESignatureProvider();
