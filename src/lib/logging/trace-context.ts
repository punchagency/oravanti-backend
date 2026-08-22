import { context, isSpanContextValid, trace } from "@opentelemetry/api";

/**
 * W3C trace correlation for log records.
 *
 * `@opentelemetry/api` is a facade with no dependencies and no behaviour of its
 * own: with no SDK registered every call here returns the invalid no-op span
 * context and the fields are simply absent. That is what lets the logging layer
 * depend on it unconditionally — logging must work in a unit test, a script and
 * a CLI command, none of which start a telemetry pipeline.
 *
 * Field names follow the OpenTelemetry log data model — `trace_id`, `span_id`,
 * `trace_flags`, lowercase with underscores, hex-encoded without the `0x`.
 * Every log backend that links logs to traces (Grafana, Honeycomb, Datadog's
 * OTel intake, the collector's own processors) looks for exactly these, and a
 * `traceId` in camelCase silently correlates with nothing.
 */

export interface TraceFields {
  trace_id?: string;
  span_id?: string;
  /** "01" when the trace is sampled. Without it a backend cannot tell whether
   *  a missing trace was dropped by sampling or lost. */
  trace_flags?: string;
}

/**
 * Resolved per record, never bound to a child logger.
 *
 * `getServiceLogger()` memoises one child per request, and the request's span
 * is not the span active when any given line is written — express, the router
 * and each instrumented database call all push their own. Binding these once
 * would attribute every line in the request to whichever span happened to be
 * active first, which is worse than not correlating at all: it looks right.
 */
export function traceFields(): TraceFields {
  const spanContext = trace.getSpanContext(context.active());

  if (!spanContext || !isSpanContextValid(spanContext)) return {};

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags.toString(16).padStart(2, "0"),
  };
}

/** The active trace id, or null outside a trace. For audit rows and responses. */
export function currentTraceId(): string | null {
  const spanContext = trace.getSpanContext(context.active());
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : null;
}
