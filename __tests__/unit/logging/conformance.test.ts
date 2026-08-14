import { describe, expect, it } from "@jest/globals";
import { Writable } from "node:stream";
import { pinoDriver } from "../../../src/lib/logging/drivers/pino.driver";
import { winstonDriver } from "../../../src/lib/logging/drivers/winston.driver";
import { REDACT_KEYS, REDACTED } from "../../../src/lib/logging/config";
import type { Logger, LoggerDriver } from "../../../src/lib/logging/types";

/**
 * Driver conformance.
 *
 * This suite is the reason LOG_DRIVER can be trusted. Everything here runs
 * against both drivers and asserts they produce the same record, so switching
 * drivers is a configuration change rather than a rewrite of every dashboard
 * and alert built on the old shape.
 *
 * A parity break must fail CI. If a test here needs a per-driver exception,
 * the abstraction has sprung a leak and the exception is the bug.
 */

const DRIVERS: Array<[string, LoggerDriver]> = [
  ["pino", pinoDriver],
  ["winston", winstonDriver],
];

/** Collects written lines so records can be asserted on as parsed objects. */
class Capture extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _enc: unknown, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }

  records(): Array<Record<string, unknown>> {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

async function collect(
  driver: LoggerDriver,
  run: (log: Logger) => void,
  level: "trace" | "info" = "trace",
): Promise<Array<Record<string, unknown>>> {
  const capture = new Capture();
  const log = driver.create({
    level,
    pretty: false,
    fileEnabled: false,
    base: { service: "oravanti-api", env: "test" },
    destination: capture,
  });

  run(log);
  await log.flush();
  return capture.records();
}

describe.each(DRIVERS)("logging conformance: %s", (name, driver) => {
  it("emits the shared field names, with the level as a string", async () => {
    const [record] = await collect(driver, (log) => log.info("hello"));

    expect(record.level).toBe("info");
    expect(record.message).toBe("hello");
    expect(record.service).toBe("oravanti-api");
    expect(record.env).toBe("test");
    expect(typeof record.time).toBe("string");

    // The two traps: pino defaults to a numeric level and a `msg` key.
    expect(record.msg).toBeUndefined();
    expect(typeof record.level).toBe("string");
  });

  it("supports every level, including the two Winston lacks natively (D2)", async () => {
    const records = await collect(driver, (log) => {
      log.trace("t");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      log.fatal("f");
    });

    expect(records.map((r) => r.level)).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
  });

  it("accepts the object-first call form and keeps the message (D1)", async () => {
    const [record] = await collect(driver, (log) =>
      log.info({ leadId: "lead_1", count: 3 }, "lead created"),
    );

    // The Winston draft's bug: object treated as the whole record, no message.
    expect(record.message).toBe("lead created");
    expect(record.leadId).toBe("lead_1");
    expect(record.count).toBe(3);
  });

  it("serialises Error under err, with the stack", async () => {
    const [record] = await collect(driver, (log) =>
      log.error({ err: new TypeError("boom") }, "request failed"),
    );

    const err = record.err as Record<string, unknown>;
    expect(err.type).toBe("TypeError");
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
    expect(String(err.stack)).toContain("boom");
    expect(record.message).toBe("request failed");
  });

  it("merges bound fields from child loggers", async () => {
    const [record] = await collect(driver, (log) =>
      log.child({ requestId: "req_1" }).info({ step: "a" }, "working"),
    );

    expect(record.requestId).toBe("req_1");
    expect(record.step).toBe("a");
    expect(record.message).toBe("working");
  });

  it("filters below the configured level", async () => {
    const records = await collect(
      driver,
      (log) => {
        log.debug("invisible");
        log.info("visible");
      },
      "info",
    );

    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe("visible");
  });

  it("reports level enablement consistently", async () => {
    const capture = new Capture();
    const log = driver.create({
      level: "warn",
      pretty: false,
      fileEnabled: false,
      base: {},
      destination: capture,
    });

    expect(log.isLevelEnabled("error")).toBe(true);
    expect(log.isLevelEnabled("warn")).toBe(true);
    expect(log.isLevelEnabled("info")).toBe(false);
    expect(log.isLevelEnabled("trace")).toBe(false);
  });

  it("resolves flush()", async () => {
    await expect(
      collect(driver, (log) => log.info("flushed")),
    ).resolves.toHaveLength(1);
  });

  describe("redaction (D3)", () => {
    it.each([1, 2, 3])("redacts every sensitive key at depth %i", async (depth) => {
      for (const key of REDACT_KEYS) {
        let payload: Record<string, unknown> = { [key]: "SENSITIVE_VALUE" };
        for (let i = 1; i < depth; i++) payload = { nested: payload };

        const [record] = await collect(driver, (log) => log.info(payload, "m"));
        expect(JSON.stringify(record)).not.toContain("SENSITIVE_VALUE");
        expect(JSON.stringify(record)).toContain(REDACTED);
      }
    });

    it("redacts a Buffer under any key, not just known ones", async () => {
      const [record] = await collect(driver, (log) =>
        log.info({ harmlessLookingName: Buffer.from("KEY_MATERIAL") }, "m"),
      );

      expect(record.harmlessLookingName).toBe(REDACTED);
      expect(JSON.stringify(record)).not.toContain("KEY_MATERIAL");
    });

    it("leaks no DEK bytes when handed a whole RequestContext", async () => {
      // The exact shape that made D3 a security bug rather than a style note.
      const ctx = {
        requestId: "req_1",
        userId: "user_1",
        organizationId: "org_1",
        rawUserDEK: Buffer.from("0123456789abcdef0123456789abcdef"),
        nested: { deeper: { rawUserDEK: Buffer.from("SECOND_COPY_OF_KEY") } },
      };

      const [record] = await collect(driver, (log) => log.debug({ ctx }, "ctx"));
      const json = JSON.stringify(record);

      expect(json).not.toContain("0123456789abcdef");
      expect(json).not.toContain("SECOND_COPY_OF_KEY");
      // A Buffer walked as an object would surface as numeric byte keys.
      expect(json).not.toContain('"type":"Buffer"');
      // Non-sensitive context is still there — redaction must not blind us.
      expect(json).toContain("req_1");
    });

    it("redacts inside arrays", async () => {
      const [record] = await collect(driver, (log) =>
        log.info({ users: [{ email: "a@b.c", password: "hunter2" }] }, "m"),
      );

      expect(JSON.stringify(record)).not.toContain("hunter2");
      expect(JSON.stringify(record)).toContain("a@b.c");
    });

    it("matches keys case-insensitively", async () => {
      const [record] = await collect(driver, (log) =>
        log.info({ Password: "p1", ACCESSTOKEN: "p2" }, "m"),
      );

      const json = JSON.stringify(record);
      expect(json).not.toContain("p1");
      expect(json).not.toContain("p2");
    });
  });
});

describe("driver parity", () => {
  it("produces byte-identical records once time is normalised", async () => {
    const write = (log: Logger) => {
      log.child({ requestId: "req_1" }).warn(
        {
          leadId: "lead_1",
          password: "hunter2",
          dek: Buffer.from("k"),
          nested: { ssn: "111-22-3333", keep: "visible" },
        },
        "parity check",
      );
    };

    const [fromPino] = await collect(pinoDriver, write);
    const [fromWinston] = await collect(winstonDriver, write);

    const normalise = (r: Record<string, unknown>) => {
      const { time, ...rest } = r;
      expect(typeof time).toBe("string");
      return rest;
    };

    expect(normalise(fromWinston!)).toEqual(normalise(fromPino!));
  });
});
