import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { createLogBridge } from "../../../src/telemetry/log-bridge";

/**
 * The OpenTelemetry log bridge.
 *
 * The property under test throughout is that a record is NOT reshaped. A log
 * line's fields arrive at the collector under the names they were written
 * with, so a field found in the console can be searched for in the backend.
 * Anything that renames, flattens or drops on the way through breaks that, and
 * breaks it invisibly — the export succeeds and the data is simply wrong.
 */

let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;

const RECORD = {
  time: "2026-08-17T09:31:54.761Z",
  level: "warn",
  message: "GET /cases 400",
  event: "http.request",
  domain: "http",
  apiModule: "cases",
  requestId: "27f85b79-da6b",
  method: "GET",
  path: "/cases",
  status: 400,
  duration_ms: 125.56,
  query: { limit: "200" },
  trace_id: "5fda92a0c7403824d17c2693ab70977a",
  span_id: "851c2c1b8a9f610b",
  trace_flags: "01",
  service: "oravanti-api",
  env: "development",
};

/** Pushes records through the bridge and returns what the exporter received. */
function bridge(...records: Array<Record<string, unknown>>): ReadableLogRecord[] {
  const stream = createLogBridge();
  for (const record of records) stream.write(`${JSON.stringify(record)}\n`);
  return exporter.getFinishedLogRecords();
}

beforeEach(() => {
  exporter = new InMemoryLogRecordExporter();
  provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.setGlobalLoggerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  logs.disable();
});

describe("the log bridge", () => {
  it("emits one LogRecord per line", () => {
    const written = bridge(RECORD, { ...RECORD, message: "second" });

    expect(written).toHaveLength(2);
    expect(written.map((r) => r.body)).toEqual(["GET /cases 400", "second"]);
  });

  it("passes every field through under its own name", () => {
    const [record] = bridge(RECORD);

    expect(record!.attributes).toMatchObject({
      event: "http.request",
      apiModule: "cases",
      requestId: "27f85b79-da6b",
      method: "GET",
      path: "/cases",
      status: 400,
      duration_ms: 125.56,
      service: "oravanti-api",
    });
  });

  it("keeps a nested object nested", () => {
    // LogAttributes is an AnyValueMap, so there is no technical reason to
    // flatten and every reason not to.
    const [record] = bridge(RECORD);

    expect(record!.attributes.query).toEqual({ limit: "200" });
  });

  it("keeps the trace fields as attributes as well as context", () => {
    const [record] = bridge(RECORD);

    expect(record!.attributes).toMatchObject({
      trace_id: "5fda92a0c7403824d17c2693ab70977a",
      span_id: "851c2c1b8a9f610b",
      trace_flags: "01",
    });
  });

  it("maps level and message onto the record's own fields", () => {
    const [record] = bridge(RECORD);

    expect(record!.severityText).toBe("warn");
    expect(record!.severityNumber).toBe(13); // warn
    expect(record!.body).toBe("GET /cases 400");
  });

  it("does not repeat the body or severity in the attributes", () => {
    // Both are first-class on the record. A second copy can disagree with the
    // first, and stores every line's text twice.
    const [record] = bridge(RECORD);

    expect(record!.attributes.message).toBeUndefined();
    expect(record!.attributes.level).toBeUndefined();
  });

  it("rebuilds the trace context from the record", () => {
    // By the time a record reaches this stream the write has crossed a tick
    // boundary and the AsyncLocalStorage context that produced it is gone. The
    // fields captured at emit time are the authoritative answer.
    const [record] = bridge(RECORD);

    expect(record!.spanContext?.traceId).toBe(
      "5fda92a0c7403824d17c2693ab70977a",
    );
    expect(record!.spanContext?.spanId).toBe("851c2c1b8a9f610b");
  });

  it("emits a record with no trace context when there was no span", () => {
    // trace_id/span_id/trace_flags are named only to omit them from the
    // rest spread — that omission IS the fixture. ignoreRestSiblings in the
    // eslint config keeps them from reading as dead bindings.
    const { trace_id, span_id, trace_flags, ...untraced } = RECORD;
    const [record] = bridge(untraced);

    expect(record!.spanContext).toBeUndefined();
    expect(record!.body).toBe("GET /cases 400");
  });

  it("carries the timestamp the record was written with", () => {
    const [record] = bridge(RECORD);

    // hrtime pair — seconds, nanoseconds.
    expect(record!.hrTime[0]).toBe(Math.floor(Date.parse(RECORD.time) / 1000));
  });

  it("survives a line that is not a record", () => {
    // A stray process.stdout.write must not take the exporter down with it.
    const stream = createLogBridge();

    expect(() => stream.write("not json\n")).not.toThrow();
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("reassembles a record split across two writes", () => {
    const stream = createLogBridge();
    const json = JSON.stringify(RECORD);

    stream.write(json.slice(0, 40));
    stream.write(`${json.slice(40)}\n`);

    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });
});
