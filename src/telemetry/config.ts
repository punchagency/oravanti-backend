/**
 * Telemetry configuration — deliberately thin.
 *
 * The OpenTelemetry SDK reads the specification's environment variables
 * itself: `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`,
 * `OTEL_METRICS_EXPORTER` (each accepting otlp / console / none),
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME`,
 * `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SDK_DISABLED`.
 *
 * An earlier version of this file parsed and validated all of those and then
 * constructed the matching exporters by hand — about ninety lines
 * reimplementing, slightly differently, what the SDK does on its own. What
 * remains is only the two questions the SDK cannot answer for us:
 *
 *   1. Should telemetry start at all? The SDK's own default, with nothing
 *      configured, is to build an OTLP exporter aimed at localhost:4318 and
 *      log a connection failure every few seconds. That is the wrong default
 *      for a service that must run with no collector anywhere near it.
 *   2. Is anything actually being exported? Needed to decide whether to
 *      register the log bridge, and whether to fall back to the
 *      correlate-only mode.
 *
 * Reads `process.env` directly rather than `config/env.ts`, for the same
 * reason the logging config does: env.ts throws unless all 22 application keys
 * are present, and telemetry loads before it. It brings its own dotenv.
 */

import "dotenv/config";

const readEnv = (key: string): string | undefined => {
  const value = process.env[key];
  return value?.trim() ? value.trim() : undefined;
};

const flag = (key: string, fallback: boolean): boolean => {
  const value = readEnv(key);
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
};

/** The per-signal exporter variables, read only to see whether any is set. */
const EXPORTER_KEYS = [
  "OTEL_TRACES_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
];

export interface TelemetryConfig {
  enabled: boolean;
  /**
   * Whether any signal has somewhere to go.
   *
   * False in the correlate-only mode — `OTEL_ENABLED=true` with no endpoint
   * and no exporter — where spans are created so that every log line carries
   * `trace_id` and `span_id`, and nothing leaves the process. That is the
   * cheapest useful configuration there is and the one to reach for first:
   * correlated logs, no infrastructure.
   */
  exporting: boolean;
  /** Whether log records should be shipped, and so whether to bridge them. */
  exportingLogs: boolean;
  endpoint: string | undefined;
  serviceName: string;
  serviceVersion: string | undefined;
  environment: string;
  /** Head sampling ratio. 1 = every trace, and the SDK's own default. */
  sampleRatio: number;
}

function resolveSampleRatio(): number {
  const raw = readEnv("OTEL_TRACES_SAMPLER_ARG");
  if (raw === undefined) return 1;

  const parsed = Number(raw);
  // An unparseable ratio silently sampling nothing is the worst outcome:
  // telemetry looks configured and reports no traces at all.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Invalid OTEL_TRACES_SAMPLER_ARG "${raw}". Expected a ratio between 0 and 1.`,
    );
  }
  return parsed;
}

export function loadTelemetryConfig(): TelemetryConfig {
  const endpoint = readEnv("OTEL_EXPORTER_OTLP_ENDPOINT");

  const exporters = EXPORTER_KEYS.map((key) => readEnv(key));
  const anyExporter = exporters.some((value) => value && value !== "none");

  const exporting = endpoint !== undefined || anyExporter;

  return {
    // OTEL_SDK_DISABLED is honoured by the SDK too; read here so this module
    // reports the truth rather than announcing a start that did not happen.
    enabled: !flag("OTEL_SDK_DISABLED", false) && flag("OTEL_ENABLED", exporting),
    exporting,
    exportingLogs: exporting && readEnv("OTEL_LOGS_EXPORTER") !== "none",
    endpoint,
    serviceName: readEnv("OTEL_SERVICE_NAME") ?? "oravanti-api",
    serviceVersion: readEnv("APP_VERSION"),
    environment: readEnv("NODE_ENV") ?? "development",
    sampleRatio: resolveSampleRatio(),
  };
}
