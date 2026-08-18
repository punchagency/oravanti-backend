import { describe, expect, it, jest } from "@jest/globals";
import { createHmac } from "crypto";

// The client module reads `config/env` at import time, which validates the whole
// environment and throws when required vars are absent. The client itself takes
// its credentials by constructor, so the mock only has to exist.
jest.mock("../../../src/config/env", () => ({ env: {} }));

import { ConfidoClient } from "../../../src/modules/finance/confido/confido.client";

const SECRET = "whsec_unit_test";
const client = new ConfidoClient("p_secret_sandbox_x", SECRET);

const sign = (body: Buffer, secret = SECRET) =>
  createHmac("sha512", secret).update(body).digest("base64");

describe("verifyWebhook", () => {
  const body = Buffer.from(
    JSON.stringify([
      { type: "firm.updated", firmId: "firm-1", eventId: "evt-1", data: {} },
    ]),
  );

  it("accepts a correct signature", () => {
    expect(client.verifyWebhook(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    // The signature is what stands between an unauthenticated endpoint and
    // anyone claiming a firm went ACTIVE.
    const signature = sign(body);
    const tampered = Buffer.from(
      JSON.stringify([
        { type: "firm.updated", firmId: "firm-2", eventId: "evt-1", data: {} },
      ]),
    );
    expect(client.verifyWebhook(tampered, signature)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(client.verifyWebhook(body, sign(body, "wrong-secret"))).toBe(false);
  });

  it("rejects a missing or empty signature without throwing", () => {
    expect(client.verifyWebhook(body, undefined)).toBe(false);
    expect(client.verifyWebhook(body, "")).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    // timingSafeEqual throws on length mismatch, so the length guard has to come
    // first — this is the case that would 500 the endpoint if it were dropped.
    expect(() => client.verifyWebhook(body, "short")).not.toThrow();
    expect(client.verifyWebhook(body, "short")).toBe(false);
  });

  it("signs the exact bytes, not a re-serialised parse", () => {
    // Confido's own sample HMACs JSON.stringify(parsedBody). Key order and
    // whitespace differ from what they sent, so verification would fail on
    // legitimate events. This pins the raw-buffer behaviour.
    const spaced = Buffer.from('[ {"type":"firm.updated"} ]');
    const compact = Buffer.from('[{"type":"firm.updated"}]');
    expect(client.verifyWebhook(spaced, sign(spaced))).toBe(true);
    expect(client.verifyWebhook(compact, sign(spaced))).toBe(false);
  });

  it("handles an empty body", () => {
    const empty = Buffer.alloc(0);
    expect(client.verifyWebhook(empty, sign(empty))).toBe(true);
  });
});
