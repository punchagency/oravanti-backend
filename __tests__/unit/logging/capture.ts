import { Writable } from "node:stream";
import { createLogger, __resetLogger, __setLogger } from "../../../src/lib/logging";

/**
 * Installs a real logger writing to an in-memory stream, and returns the
 * records it emits.
 *
 * Deliberately not a jest.mock of the logging API. Mocking asserts that a
 * function was called; this asserts what was actually written — which is what
 * redaction, error serialisation and the field envelope all live in. It also
 * sidesteps jest.mock hoisting, which was silently a no-op in this project
 * until the swc transform was told to hoist.
 *
 *   const logs = captureLogs();
 *   ...
 *   expect(logs.records()[0]).toMatchObject({ event: "http.request" });
 *
 * Call `logs.restore()` in afterEach, or the installed logger leaks into the
 * next test file sharing the module registry.
 */
export interface LogCapture {
  /** Every record written since the last reset, parsed. */
  records(): Record<string, any>[];
  /** The single record written. Fails loudly if there is not exactly one. */
  only(): Record<string, any>;
  clear(): void;
  restore(): void;
}

export function captureLogs(level = "trace"): LogCapture {
  const lines: string[] = [];

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      // A driver may write several records in one chunk, or split one across
      // chunks; both drivers newline-delimit, so split rather than assume.
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(line);
      }
      callback();
    },
  });

  __setLogger(
    createLogger({ level: level as any, format: "json", destination }),
  );

  const records = () =>
    lines.map((line) => JSON.parse(line) as Record<string, any>);

  return {
    records,
    only: () => {
      const all = records();
      if (all.length !== 1) {
        throw new Error(
          `expected exactly one log record, got ${all.length}:\n${lines.join("\n")}`,
        );
      }
      return all[0];
    },
    clear: () => {
      lines.length = 0;
    },
    restore: () => {
      lines.length = 0;
      __resetLogger();
    },
  };
}
