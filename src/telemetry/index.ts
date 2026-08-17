import { DiagLogLevel, diag } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  NoopSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";

import { addLogSink, removeLogSink } from "../lib/logging/sinks";
import { LogEvent, createModuleLogger } from "../lib/logging/log";
import { loadTelemetryConfig, type TelemetryConfig } from "./config";
import { createLogBridge } from "./log-bridge";

/**
 * OpenTelemetry bootstrap (plan-02 step 34).
 *
 * ── Import order matters more than anything else in this file ────────────────
 *
 * Instrumentation works by patching modules as they are required, so this must
 * run before express, pg or ioredis are imported anywhere. `src/index.ts`
 * imports it on its first line, ahead of `config/env` — which is also why this
 * module reads process.env itself and brings its own dotenv.
 *
 * ── The packages ─────────────────────────────────────────────────────────────
 *
 * Verified against the registry rather than copied from the draft, which was
 * wrong on three counts (defect D4):
 *
 *   - `@opentelemetry/exporter-logs` does not exist and never has. The package
 *     is `@opentelemetry/exporter-logs-otlp-http`.
 *   - `new Resource({...})` is gone; `@opentelemetry/resources` now exports
 *     `resourceFromAttributes` and nothing else that fits.
 *   - `logRecordProcessor` (singular) is deprecated in favour of
 *     `logRecordProcessors: []`.
 *
 * Instrumentations are named individually instead of using
 * `auto-instrumentations-node`, which installs roughly forty packages to patch
 * libraries this service does not use. These four cover every I/O boundary the
 * app actually has: inbound and outbound HTTP, express routing, Postgres, and
 * the BullMQ Redis connection.
 */

const log = createModuleLogger("telemetry");

/**
 * The auto-instrumentation set, configured rather than accepted as-is.
 *
 * `getNodeAutoInstrumentations()` bundles 39 instrumentations and activates
 * only those whose target module is actually loaded, so the unused ones cost
 * install size rather than runtime. It is the right default, and picking four
 * by hand — as the first version of this file did — was not: it missed
 * `undici`, so every outbound call made with native fetch (Google, Stripe,
 * Dropbox Sign, the AI service) produced no span, and it missed `aws-sdk`, so
 * neither did an R2 upload. Those are precisely the calls that hang.
 *
 * Four deliberate overrides:
 */
export const INSTRUMENTATION_CONFIG: Record<string, Record<string, unknown>> = {
  /*
   * The log instrumentations are OFF, and this is not optional.
   *
   * Both default to sending log records to the OTel Logs API themselves. Left
   * on alongside the bridge in ./log-bridge, every line would be exported
   * twice — once by whichever driver is loaded and once by us — which doubles
   * the log bill and makes every count derived from it wrong.
   *
   * The bridge wins the conflict on merit, not just on ordering: it maps
   * fields onto semantic conventions, where these transports ship whatever
   * keys the call site happened to use; and it reads the serialised record, so
   * it sees the same redacted output that reaches stdout. It also behaves
   * identically under both drivers, which two separate transports cannot.
   */
  "@opentelemetry/instrumentation-pino": { enabled: false },
  "@opentelemetry/instrumentation-winston": { enabled: false },
  "@opentelemetry/instrumentation-bunyan": { enabled: false },

  "@opentelemetry/instrumentation-http": {
    // The load balancer probes these every couple of seconds. Traced, they
    // would be most of the trace volume and none of the value — the same
    // reasoning that keeps them out of the access log.
    ignoreIncomingRequestHook: (request: { url?: string }) => {
      const path = (request.url ?? "").split("?")[0];
      return path === "/health" || path === "/health/live";
    },
  },

  // Statements are recorded, values are not. This database holds client PII
  // under attorney–client privilege, and bound parameters in a span attribute
  // would put it in the telemetry backend in clear text.
  "@opentelemetry/instrumentation-pg": { enhancedDatabaseReporting: false },

  // A span per socket and per DNS lookup, none of which is actionable, all of
  // which sits under the span you actually wanted to read.
  "@opentelemetry/instrumentation-net": { enabled: false },
  "@opentelemetry/instrumentation-dns": { enabled: false },
};

let sdk: NodeSDK | undefined;
let bridge: NodeJS.WritableStream | undefined;
let active: TelemetryConfig | undefined;

/**
 * Routes the SDK's own diagnostics into the application logger.
 *
 * Without this the SDK writes to console, so an exporter that cannot reach the
 * collector reports it in a format nothing parses, with no requestId, on a
 * stream the log shipper treats as unstructured. A telemetry pipeline that
 * fails silently is worse than none, because everything downstream reads as
 * "no errors occurred".
 */
function installDiagnostics(): void {
  diag.setLogger(
    {
      error: (message, ...args) =>
        log.failure(LogEvent.TELEMETRY_ERROR, args[0], { message }),
      warn: (message) => log.warn(LogEvent.TELEMETRY_WARNING, { message }),
      info: (message) => log.debug(LogEvent.TELEMETRY_DIAGNOSTIC, { message }),
      debug: (message) => log.trace(LogEvent.TELEMETRY_DIAGNOSTIC, { message }),
      verbose: (message) => log.trace(LogEvent.TELEMETRY_DIAGNOSTIC, { message }),
    },
    // Warnings and errors only. The SDK's info level narrates every export.
    DiagLogLevel.WARN,
  );
}

/**
 * The correlate-only mode: SDK running, nothing exported.
 *
 * Not an empty array, and not simply omitting the key. Given nothing to do
 * with spans, NodeSDK registers no tracer provider at all, `trace.getTracer()`
 * hands back the API's built-in NoopTracer, and every span context is the
 * invalid one — so no log line gets a `trace_id`. Omitting the key instead
 * makes the SDK build an OTLP exporter aimed at localhost:4318 and report a
 * connection failure every few seconds.
 *
 * A processor that discards keeps the provider real. Spans are created,
 * sampled and given ids; they are simply never sent anywhere. Logs and metrics
 * take empty arrays because for them "no provider" is the correct outcome.
 */
const NOTHING_EXPORTED = {
  spanProcessors: [new NoopSpanProcessor()],
  logRecordProcessors: [],
  metricReaders: [],
};

function buildSdk(config: TelemetryConfig): NodeSDK {
  /*
   * Merged with the detected resource rather than replacing it. Passing a bare
   * resource drops everything `autoDetectResources` found — host, process,
   * runtime, container and cloud attributes — which are how you tell two
   * instances of this service apart in a backend.
   */
  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.serviceVersion
        ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
        : {}),
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    }),
  );

  return new NodeSDK({
    resource,

    /*
     * Sampling is parent-based, with the ratio applied only at the root.
     *
     * A bare ratio sampler decides independently at every service, so a trace
     * spanning three of them is kept by one and dropped by the next, and what
     * arrives is a collection of fragments. Deferring to the parent's decision
     * means a trace is sampled as a whole or not at all — which is the only
     * form in which sampled traces are worth looking at.
     */
    ...(config.sampleRatio < 1
      ? {
          sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(config.sampleRatio),
          }),
        }
      : {}),

    /*
     * No exporters are constructed here. The SDK reads OTEL_TRACES_EXPORTER,
     * OTEL_LOGS_EXPORTER and OTEL_METRICS_EXPORTER itself — each accepting
     * otlp, console or none — and builds the matching exporter with the right
     * processor for it. Building them by hand, as this file used to, is ninety
     * lines that can only diverge from the specification the collector expects.
     *
     * The one case it cannot express is "run, but export nothing".
     */
    ...(config.exporting ? {} : NOTHING_EXPORTED),

    instrumentations: [getNodeAutoInstrumentations(INSTRUMENTATION_CONFIG)],
  });
}

/**
 * Starts telemetry if it is configured. Returns whether it did.
 *
 * A failure to start is logged and swallowed. Observability going down must
 * not take the service with it — that trade is only ever worth making the
 * other way round in a system whose job is telemetry.
 */
export function startTelemetry(): boolean {
  if (sdk) return true;

  const config = loadTelemetryConfig();

  if (!config.enabled) {
    // Info, not debug. "Telemetry is off" is a fact about how this process
    // will behave for its whole life, and one line at startup is what stops
    // someone concluding the pipeline is broken when it was never switched on.
    log.info(
      LogEvent.TELEMETRY_DISABLED,
      { hint: "set OTEL_ENABLED=true, or OTEL_EXPORTER_OTLP_ENDPOINT" },
      "telemetry disabled — logs will carry no trace_id",
    );
    return false;
  }

  try {
    installDiagnostics();

    sdk = buildSdk(config);
    sdk.start();
    active = config;

    // Registered after start(), so the logger provider is in place before the
    // first record can reach the bridge. Skipped when logs are not exported —
    // otherwise every record is serialised into an OTel LogRecord and handed
    // to a provider with nothing to do with it.
    if (config.exportingLogs) {
      bridge = createLogBridge();
      addLogSink(bridge);
    }

    log.info(
      LogEvent.TELEMETRY_STARTED,
      {
        service: config.serviceName,
        environment: config.environment,
        exporting: config.exporting,
        logBridge: config.exportingLogs,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        ...(config.sampleRatio < 1 ? { sampleRatio: config.sampleRatio } : {}),
      },
      config.exporting
        ? "telemetry started"
        : "telemetry started — correlating logs, exporting nothing",
    );

    return true;
  } catch (error) {
    sdk = undefined;
    log.failure(LogEvent.TELEMETRY_START_FAILED, error);
    return false;
  }
}

/**
 * Flushes and stops the pipeline. Await this on the shutdown path.
 *
 * Both exporters batch, so without this the spans and logs describing a
 * shutdown — including whatever caused it — are still in a buffer when the
 * process exits, and the most interesting minute of the service's life is the
 * one minute that never leaves the machine.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;

  if (bridge) {
    removeLogSink(bridge);
    bridge = undefined;
  }

  try {
    await sdk.shutdown();
  } catch (error) {
    log.failure(LogEvent.TELEMETRY_SHUTDOWN_FAILED, error);
  } finally {
    sdk = undefined;
    active = undefined;
  }
}

export function isTelemetryEnabled(): boolean {
  return sdk !== undefined;
}

/** The configuration in force, or undefined when telemetry is off. */
export function telemetryConfig(): TelemetryConfig | undefined {
  return active;
}

export { currentTraceId } from "../lib/logging/trace-context";
export { annotateSpan, recordSpanException, withSpan } from "./span";
export type { TelemetryConfig } from "./config";
