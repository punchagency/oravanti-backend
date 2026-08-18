import { describe, expect, it } from "@jest/globals";
import { Writable } from "node:stream";
import { renderJsonPretty, renderPretty } from "../../../src/lib/logging/pretty";
import { pinoDriver } from "../../../src/lib/logging/drivers/pino.driver";
import { winstonDriver } from "../../../src/lib/logging/drivers/winston.driver";
import type { LoggerDriver } from "../../../src/lib/logging/types";

/**
 * Human-readable rendering.
 *
 * Two things are being protected here. One is that `json-pretty` stays valid
 * JSON, because the entire point of the mode is that a record can be selected
 * out of the terminal and pasted somewhere that will parse it. The other is
 * driver parity: the previous arrangement rendered pino through pino-pretty
 * and winston through a hand-rolled printf, so switching LOG_DRIVER changed
 * what a developer saw and no test noticed.
 */

const RECORD = {
  time: "2026-08-17T09:31:54.761Z",
  level: "warn",
  message: "GET /cases 400",
  event: "http.request",
  domain: "http",
  apiModule: "cases",
  requestId: "27f85b79-da6b",
  status: 400,
  duration_ms: 125.56,
  aborted: false,
  referer: null,
  query: { limit: "200" },
  service: "oravanti-api",
  env: "development",
};

 
const ANSI = /\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "");

describe("renderPretty", () => {
  it("puts the time, level, source and message on one header line", () => {
    const [header] = plain(renderPretty(RECORD, false)).split("\n");

    expect(header).toBe("09:31:54.761 WARN  (cases) GET /cases 400");
  });

  it("prefers the writing module over the API module in the header", () => {
    // Which code wrote the line is the more specific answer, and the one you
    // want when a shared service is called from several routes.
    const [header] = plain(
      renderPretty({ ...RECORD, module: "leads.service" }, false),
    ).split("\n");

    expect(header).toContain("(leads.service)");
  });

  it("starts every value at the same column", () => {
    // Ragged values are the difference between scanning a block and reading it.
    const valueColumns = plain(renderPretty(RECORD, false))
      .split("\n")
      .map((line) => /^ {2}(\S+ *) {2}(?=\S)/.exec(line))
      .filter(Boolean)
      .map((match) => match![0].length);

    expect(valueColumns.length).toBeGreaterThan(3);
    expect(new Set(valueColumns).size).toBe(1);
  });

  it("drops the fields that are the same on every line", () => {
    // service and env are constant for the life of the process; repeated on
    // every line they are pure noise. They stay in the JSON formats.
    const out = plain(renderPretty(RECORD, false));

    expect(out).not.toContain("oravanti-api");
    expect(out).toContain("apiModule");
  });

  it("keeps a falsy field rather than hiding it", () => {
    // `aborted: false` and `referer: null` are answers, not absences.
    const out = plain(renderPretty(RECORD, false));

    expect(out).toContain("aborted");
    expect(out).toContain("false");
    expect(out).toContain("referer");
  });

  it("renders an error as a marked line plus indented frames", () => {
    const out = plain(
      renderPretty(
        {
          ...RECORD,
          err: {
            type: "TypeError",
            message: "boom",
            code: "42501",
            stack: "TypeError: boom\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)",
          },
        },
        false,
      ),
    );

    expect(out).toContain("✖ TypeError: boom");
    expect(out).toContain("code 42501");
    expect(out).toContain("at one (a.ts:1:1)");
    expect(out).toContain("at two (b.ts:2:2)");
  });

  it("emits no escape sequences when colour is off", () => {
    // A redirected file or a CI log full of escapes is unreadable and breaks
    // grep, which is why colour is a parameter rather than a global.
    expect(renderPretty(RECORD, false)).not.toMatch(ANSI);
    expect(renderPretty(RECORD, true)).toMatch(ANSI);
  });

  it("survives a record with nothing but a message", () => {
    expect(plain(renderPretty({ level: "info", message: "hello" }, false))).toContain(
      "INFO  hello",
    );
  });
});

describe("renderJsonPretty", () => {
  const parsed = (record: Record<string, unknown>) =>
    JSON.parse(renderJsonPretty(record, false));

  it("round-trips the record", () => {
    expect(parsed(RECORD)).toEqual(RECORD);
  });

  it("is still valid JSON with an error, a nested object and an empty one", () => {
    expect(() =>
      parsed({
        ...RECORD,
        empty: {},
        list: [],
        nested: { a: { b: [1, true, null, "x"] } },
        err: { type: "Error", message: 'quotes "inside"', stack: "Error: x\n  at y" },
      }),
    ).not.toThrow();
  });

  it("leads with the fields that identify the record", () => {
    const keys = Object.keys(parsed(RECORD));

    expect(keys.slice(0, 5)).toEqual([
      "time",
      "level",
      "message",
      "event",
      "domain",
    ]);
  });

  it("splits the stack into frames", () => {
    // As one string it is a single enormous line of \n escapes, which defeats
    // the purpose of the format.
    const out = parsed({
      ...RECORD,
      err: { type: "Error", message: "x", stack: "Error: x\n    at one (a.ts:1:1)" },
    });

    expect(out.err.stack).toEqual(["at one (a.ts:1:1)"]);
  });

  it("keeps every field, including the constant ones", () => {
    // Unlike `pretty`, this mode is for reading one record in full — possibly
    // one that has been copied away from the process that produced it.
    expect(parsed(RECORD).service).toBe("oravanti-api");
  });

  it("colours without breaking the JSON when the escapes are stripped", () => {
    const coloured = renderJsonPretty(RECORD, true);

    expect(coloured).toMatch(ANSI);
    expect(JSON.parse(plain(coloured))).toEqual(RECORD);
  });
});

/* ── Driver parity ──────────────────────────────────────────────────────── */

const DRIVERS: Array<[string, LoggerDriver]> = [
  ["pino", pinoDriver],
  ["winston", winstonDriver],
];

/** Runs one log call through a driver and returns the record it serialised. */
async function record(driver: LoggerDriver): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const log = driver.create({
    level: "trace",
    format: "json",
    fileEnabled: false,
    base: { service: "oravanti-api", env: "test" },
    destination,
  });

  log.warn(
    { event: "http.request", apiModule: "cases", status: 400, query: { limit: "200" } },
    "GET /cases 400",
  );
  await log.flush();

  const line = chunks.join("").split("\n").find((l) => l.trim())!;
  return JSON.parse(line) as Record<string, unknown>;
}

describe("driver parity", () => {
  it("renders the two drivers' records identically", async () => {
    const [pino, winston] = await Promise.all(DRIVERS.map(([, d]) => record(d)));

    // The timestamps differ by microseconds; nothing else may.
    const normalise = (r: Record<string, unknown>) => ({ ...r, time: "T" });

    expect(plain(renderPretty(normalise(winston!), false))).toBe(
      plain(renderPretty(normalise(pino!), false)),
    );
    expect(JSON.parse(renderJsonPretty(normalise(winston!), false))).toEqual(
      JSON.parse(renderJsonPretty(normalise(pino!), false)),
    );
  });
});
