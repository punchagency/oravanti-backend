// `jest` is deliberately NOT imported from @jest/globals here — see the note on
// jest.mock below. The bare global is typed via @types/jest.
import { describe, expect, it } from "@jest/globals";

// `payment-crypto` reads the key through `config/env`, which validates the whole
// environment at import time and throws when required vars are absent. Mocking
// it keeps this test to the crypto, and lets a case swap the key to prove that
// a value encrypted under one key cannot be read under another.
const mockEnv: { CONTRACTOR_PAYMENT_ENCRYPTION_KEY?: string; PAYMENT_ENCRYPTION_KEY?: string } = {
  PAYMENT_ENCRYPTION_KEY: "unit-test-payment-key",
};

/*
  Two things here are load-bearing, and both are about swc's hoisting.

  **`jest` must be the global, not the `@jest/globals` import.** swc only
  recognises a bare `jest.mock(...)` call. Import `jest` and the call compiles
  to `_globals.jest.mock(...)`, which swc leaves exactly where it stands —
  after the `require()` it was supposed to intercept. The mock then registers
  too late, jest serves the real module, and the suite silently tests
  production code against whatever is in the developer's own `.env`. That is
  what was happening here: the cases that only read the initial key passed, and
  the three that mutate it failed.

  **The factory must not dereference `mockEnv` eagerly.** Hoisting puts
  `jest.mock` above everything, including the `const mockEnv` below, so the
  factory runs while that binding is still in its temporal dead zone. A getter
  defers the lookup to each property access, by which point the declaration has
  run.

  The alternative, used by other suites in this repo, is `await import()`
  inside the test body — it defers the require rather than advancing the mock.
*/
jest.mock("../../../src/config/env", () => ({
  get env() {
    return mockEnv;
  },
}));

import {
  decryptPaymentValue,
  encryptPaymentValue,
  isPaymentEncryptionConfigured,
  PaymentDecryptionError,
} from "../../../src/utils/payment-crypto";

describe("encryptPaymentValue / decryptPaymentValue", () => {
  it("round-trips a value", () => {
    const token = "f_secret_sandbox_92828393assdj3";
    expect(decryptPaymentValue(encryptPaymentValue(token))).toBe(token);
  });

  it("produces a different ciphertext every time", () => {
    // A random IV per call, so an attacker cannot tell that two firms share a
    // token, and identical values do not produce identical columns.
    const a = encryptPaymentValue("same-value");
    const b = encryptPaymentValue("same-value");
    expect(a).not.toBe(b);
    expect(decryptPaymentValue(a)).toBe(decryptPaymentValue(b));
  });

  it("stores iv:authTag:ciphertext as hex", () => {
    const parts = encryptPaymentValue("x").split(":");
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).toMatch(/^[0-9a-f]+$/);
  });

  it("trims the value before encrypting, matching the original behaviour", () => {
    expect(decryptPaymentValue(encryptPaymentValue("  padded  "))).toBe("padded");
  });

  it("round-trips values the API actually carries", () => {
    for (const value of ["a", "0".repeat(4096), "üñïçø∂é ✂ 🔐"]) {
      expect(decryptPaymentValue(encryptPaymentValue(value))).toBe(value);
    }
  });

  it("rejects a malformed value rather than throwing a raw crypto error", () => {
    for (const bad of ["", "nope", "one:two", "a:b:c:d"]) {
      expect(() => decryptPaymentValue(bad)).toThrow(PaymentDecryptionError);
    }
  });

  it("rejects a tampered ciphertext", () => {
    // GCM's whole point: a modified ciphertext fails the auth tag rather than
    // decrypting to plausible garbage.
    const [iv, tag, cipher] = encryptPaymentValue("original").split(":") as [
      string,
      string,
      string,
    ];
    const flipped = cipher.startsWith("a")
      ? `b${cipher.slice(1)}`
      : `a${cipher.slice(1)}`;
    expect(() => decryptPaymentValue(`${iv}:${tag}:${flipped}`)).toThrow(
      PaymentDecryptionError,
    );
  });

  it("cannot read a value encrypted under a different key", () => {
    // The failure mode that matters operationally: toggling
    // CONTRACTOR_PAYMENT_ENCRYPTION_KEY between deploys changes the key in force
    // and silently orphans every stored credential.
    const encrypted = encryptPaymentValue("secret");
    mockEnv.CONTRACTOR_PAYMENT_ENCRYPTION_KEY = "a-different-key";
    try {
      expect(() => decryptPaymentValue(encrypted)).toThrow(PaymentDecryptionError);
    } finally {
      delete mockEnv.CONTRACTOR_PAYMENT_ENCRYPTION_KEY;
    }
  });

  it("prefers the contractor key when both are set, as it always has", () => {
    mockEnv.CONTRACTOR_PAYMENT_ENCRYPTION_KEY = "contractor-key";
    const underContractorKey = encryptPaymentValue("value");
    delete mockEnv.CONTRACTOR_PAYMENT_ENCRYPTION_KEY;

    // Now only PAYMENT_ENCRYPTION_KEY is set, so the earlier value is unreadable.
    expect(() => decryptPaymentValue(underContractorKey)).toThrow(
      PaymentDecryptionError,
    );
  });
});

describe("isPaymentEncryptionConfigured", () => {
  it("is true when either key is present", () => {
    expect(isPaymentEncryptionConfigured()).toBe(true);
  });

  it("is false when neither is", () => {
    const saved = mockEnv.PAYMENT_ENCRYPTION_KEY;
    delete mockEnv.PAYMENT_ENCRYPTION_KEY;
    try {
      expect(isPaymentEncryptionConfigured()).toBe(false);
    } finally {
      mockEnv.PAYMENT_ENCRYPTION_KEY = saved;
    }
  });
});
