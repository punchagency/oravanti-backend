import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  currentTraceId,
  traceFields,
} from "../../../src/lib/logging/trace-context";
import { toSpanAttributes } from "../../../src/telemetry/attributes";
import { loadTelemetryConfig } from "../../../src/telemetry/config";

/**
 * OpenTelemetry integration (plan-02 step 34).
 *
 * No SDK is started in any of these. That is deliberate for the trace-context
 * tests — the API facade's behaviour with no provider registered is exactly
 * what a unit test, a script and a CLI command all get, and "it degrades to
 * nothing, silently and cheaply" is the property that lets the logging layer
 * depend on it unconditionally.
 */

const SPAN_CONTEXT = {
  traceId: "5fda92a0c7403824d17c2693ab70977a",
  spanId: "851c2c1b8a9f610b",
  traceFlags: TraceFlags.SAMPLED,
  isRemote: false,
};

/** Runs `fn` with a span context active, without standing up an SDK. */
const withTrace = <T>(fn: () => T, spanContext = SPAN_CONTEXT): T =>
  context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn);

describe("trace correlation fields", () => {
  // A context manager and nothing else. `context.with()` is a passthrough
  // until one is registered, which is the whole reason the fields are absent
  // outside a telemetry pipeline — so it has to be installed to test the
  // populated case, and only that case.
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  it("is empty when no span is active", () => {
    expect(traceFields()).toEqual({});
    expect(currentTraceId()).toBeNull();
  });

  it("carries the ids in the OTel log data model's spelling", () => {
    // trace_id, not traceId. Every backend that links logs to traces looks for
    // the snake_case form, and a camelCase key correlates with nothing at all
    // — while looking, in the log, exactly as though it had worked.
    expect(withTrace(traceFields)).toEqual({
      trace_id: "5fda92a0c7403824d17c2693ab70977a",
      span_id: "851c2c1b8a9f610b",
      trace_flags: "01",
    });
  });

  it("distinguishes a sampled trace from an unsampled one", () => {
    // Without the flag a backend cannot tell a trace that was dropped by
    // sampling from one that was lost.
    const unsampled = withTrace(traceFields, {
      ...SPAN_CONTEXT,
      traceFlags: TraceFlags.NONE,
    });

    expect(unsampled.trace_flags).toBe("00");
  });

  it("ignores an invalid span context", () => {
    // All-zero ids are what the API hands back for a non-recording span.
    const fields = withTrace(traceFields, {
      ...SPAN_CONTEXT,
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
    });

    expect(fields).toEqual({});
  });
});

describe("span attributes", () => {
  it("keeps every field under the name it was written with", () => {
    // No mapping table. The fields with real semantic conventions —
    // http.request.method, url.path, client.address — are set on the same span
    // by the HTTP instrumentation, from the request itself.
    const attributes = toSpanAttributes({
      requestId: "req-1",
      userId: "usr_9f2c",
      status: 400,
    });

    expect(attributes).toEqual({
      requestId: "req-1",
      userId: "usr_9f2c",
      status: 400,
    });
  });

  it("flattens nested objects into filterable keys", () => {
    // Span attributes, unlike log attributes, may only hold primitives — so a
    // structured field has to be flattened to survive at all. A flattened key
    // is filterable; a stringified object can only be grepped.
    const attributes = toSpanAttributes({
      details: { source: "query", issues: { count: 3 } },
    });

    expect(attributes["details.source"]).toBe("query");
    expect(attributes["details.issues.count"]).toBe(3);
  });

  it("keeps a homogeneous array and encodes a mixed one", () => {
    const attributes = toSpanAttributes({
      tags: ["a", "b"],
      mixed: [1, "two", { three: 3 }],
    });

    expect(attributes.tags).toEqual(["a", "b"]);
    expect(typeof attributes.mixed).toBe("string");
  });

  it("drops null and undefined but keeps a falsy value", () => {
    const attributes = toSpanAttributes({ a: null, b: undefined, c: 0, d: false });

    expect(attributes).toEqual({ c: 0, d: false });
  });
});

describe("the auto-instrumentation set", () => {
  it("covers the outbound calls a hand-picked list missed", async () => {
    // The first version of the telemetry module named four instrumentations by
    // hand and so produced no span for anything using native fetch (Google,
    // Stripe, Dropbox Sign, the AI service) or the S3 client (R2 uploads) —
    // exactly the calls that hang.
    const { getNodeAutoInstrumentations } = await import(
      "@opentelemetry/auto-instrumentations-node"
    );

    const names = getNodeAutoInstrumentations().map((i) =>
      i.instrumentationName.replace("@opentelemetry/instrumentation-", ""),
    );

    for (const required of ["http", "express", "pg", "ioredis", "undici", "aws-sdk"]) {
      expect(names).toContain(required);
    }
  });

  it("disables the log instrumentations that would double every record", async () => {
    // instrumentation-pino and instrumentation-winston both send log records
    // to the OTel Logs API themselves. Left enabled alongside our bridge every
    // line is exported twice, which doubles the log bill and makes every count
    // derived from it wrong — while looking, in the backend, entirely normal.
    const { INSTRUMENTATION_CONFIG } = await import("../../../src/telemetry");

    for (const name of ["pino", "winston", "bunyan"]) {
      expect(
        INSTRUMENTATION_CONFIG[`@opentelemetry/instrumentation-${name}`],
      ).toEqual({ enabled: false });
    }
  });
});

describe("telemetry configuration", () => {
  const KEYS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_ENABLED",
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_TRACES_SAMPLER_ARG",
  ];

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /*
   * This module answers only two questions the SDK cannot: whether telemetry
   * should start at all, and whether anything is being exported. Which
   * exporter each signal uses, and whether the name is valid, is read and
   * validated by the SDK from the same OTEL_* variables — so there is nothing
   * here asserting that `console` builds a ConsoleSpanExporter. That was
   * ninety lines of this file, and deleting it is the point.
   */

  it("is off when nothing is configured", () => {
    // The SDK's own default is an OTLP exporter aimed at localhost:4318 and a
    // connection failure every few seconds. Wrong for a service that has to
    // run with no collector anywhere near it.
    const config = loadTelemetryConfig();

    expect(config.enabled).toBe(false);
    expect(config.exporting).toBe(false);
  });

  it("turns on, and exports, when an endpoint is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const config = loadTelemetryConfig();

    expect(config.enabled).toBe(true);
    expect(config.exporting).toBe(true);
    expect(config.exportingLogs).toBe(true);
  });

  it("runs without exporting when only OTEL_ENABLED is set", () => {
    // The cheapest useful configuration: spans exist, so every log line gains
    // trace_id and span_id, and no collector has to.
    process.env.OTEL_ENABLED = "true";

    const config = loadTelemetryConfig();

    expect(config.enabled).toBe(true);
    expect(config.exporting).toBe(false);
    expect(config.exportingLogs).toBe(false);
  });

  it("turns itself on for a console exporter alone", () => {
    process.env.OTEL_TRACES_EXPORTER = "console";

    const config = loadTelemetryConfig();

    expect(config.enabled).toBe(true);
    expect(config.exporting).toBe(true);
  });

  it("does not bridge logs when logs are explicitly off", () => {
    // Otherwise every record is serialised into a LogRecord and handed to a
    // provider with nothing to do with it.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_LOGS_EXPORTER = "none";

    const config = loadTelemetryConfig();

    expect(config.exporting).toBe(true);
    expect(config.exportingLogs).toBe(false);
  });

  it("treats an exporter set to none as nothing configured", () => {
    process.env.OTEL_TRACES_EXPORTER = "none";

    expect(loadTelemetryConfig().enabled).toBe(false);
  });

  it("lets OTEL_SDK_DISABLED override an endpoint", () => {
    // The specification's kill switch, for silencing a service without
    // redeploying it. It has to outrank everything or it is not a kill switch.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_SDK_DISABLED = "true";

    expect(loadTelemetryConfig().enabled).toBe(false);
  });

  it("rejects a sampling ratio that would silently drop everything", () => {
    // A ratio that fails to parse and defaults to 0 is the worst outcome:
    // telemetry looks configured and reports no traces at all.
    process.env.OTEL_TRACES_SAMPLER_ARG = "half";

    expect(() => loadTelemetryConfig()).toThrow(/OTEL_TRACES_SAMPLER_ARG/);
  });

  it("accepts a valid ratio", () => {
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.25";

    expect(loadTelemetryConfig().sampleRatio).toBe(0.25);
  });
});
