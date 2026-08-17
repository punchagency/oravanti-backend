import { afterEach, describe, expect, it } from "@jest/globals";
import { Writable } from "node:stream";
import {
  __clearLogSinks,
  addLogSink,
  alsoWriteToSinks,
  hasLogSinks,
  removeLogSink,
} from "../../../src/lib/logging/sinks";
import { createLogger } from "../../../src/lib/logging";
import type { LogFormat } from "../../../src/lib/logging/types";

/**
 * The sink registry — the seam the OpenTelemetry log bridge attaches to.
 *
 * The delivery test below is a regression test for a bug that shipped in this
 * file and would have been close to undiagnosable in production: the wrapper
 * forwarded `(chunk, encoding, callback)` to the primary destination, and
 * pino's destination is a SonicBoom, whose write() takes the data and ignores
 * everything after it. The callback never fired, Node never requested another
 * chunk, and every record after the first sat in the stream's buffer. Under
 * the winston driver it worked; under pino, telemetry received exactly one log
 * line per process and stdout stopped.
 */

/** Collects the records written to a sink. */
function recordingSink() {
  const lines: string[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(line);
      }
      callback();
    },
  });

  return { stream, lines };
}

afterEach(() => {
  __clearLogSinks();
});

describe("the sink registry", () => {
  it("reports whether anything is listening", () => {
    const { stream } = recordingSink();

    expect(hasLogSinks()).toBe(false);
    addLogSink(stream);
    expect(hasLogSinks()).toBe(true);
    removeLogSink(stream);
    expect(hasLogSinks()).toBe(false);
  });

  it("delivers to every registered sink", () => {
    const a = recordingSink();
    const b = recordingSink();
    addLogSink(a.stream);
    addLogSink(b.stream);

    alsoWriteToSinks(new Writable({ write: (_c, _e, cb) => cb() })).write(
      "one\n",
    );

    expect(a.lines).toEqual(["one"]);
    expect(b.lines).toEqual(["one"]);
  });

  it("keeps the primary working when a sink throws", () => {
    // A broken exporter must not be able to fail the request that logged.
    const primary = recordingSink();
    addLogSink({
      write() {
        throw new Error("exporter is down");
      },
    });

    const stream = alsoWriteToSinks(primary.stream);

    expect(() => stream.write("still here\n")).not.toThrow();
    expect(primary.lines).toEqual(["still here"]);
  });
});

/* ── Delivery across every driver and format ────────────────────────────── */

const COMBINATIONS: Array<[string, LogFormat]> = [
  ["pino", "json"],
  ["pino", "pretty"],
  ["pino", "json-pretty"],
  ["winston", "json"],
  ["winston", "pretty"],
  ["winston", "json-pretty"],
];

describe("delivery to a sink", () => {
  const RECORDS = 25;

  it.each(COMBINATIONS)(
    "loses nothing under %s / %s",
    async (driver, format) => {
      process.env.LOG_DRIVER = driver;
      const sink = recordingSink();
      addLogSink(sink.stream);

      // The primary is a destination stream, which keeps the driver's output
      // off the test runner's stdout; the sink is what is being measured.
      const swallow = new Writable({ write: (_c, _e, cb) => cb() });
      const log = createLogger({ level: "info", format, destination: swallow });

      for (let i = 0; i < RECORDS; i++) log.info({ n: i }, `line ${i}`);
      await log.flush();

      expect(sink.lines).toHaveLength(RECORDS);
      expect(JSON.parse(sink.lines[0]!).message).toBe("line 0");
      expect(JSON.parse(sink.lines.at(-1)!).message).toBe(`line ${RECORDS - 1}`);
    },
  );

  afterEach(() => {
    delete process.env.LOG_DRIVER;
  });
});
