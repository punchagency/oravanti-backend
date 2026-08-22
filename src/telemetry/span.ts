import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import { serialiseError } from "../lib/logging/redact";
import { toSpanAttributes } from "./attributes";

/**
 * Span helpers.
 *
 * Everything here depends only on `@opentelemetry/api`, which is a facade: with
 * no SDK registered the active span is a non-recording no-op and each of these
 * costs a property read. That is what makes it safe to call them from ordinary
 * middleware and services without guarding on whether telemetry is configured.
 */

const TRACER_NAME = "oravanti";

/**
 * Adds attributes to the span already in flight, if there is one.
 *
 * Used to hang the request's identity — request id, user, tenant — on the span
 * the HTTP instrumentation created. Without it a trace can be found by URL and
 * by latency and by nothing else; with it, "every slow request for this firm
 * last Tuesday" is a query rather than an afternoon.
 */
export function annotateSpan(fields: Record<string, unknown>): void {
  const span = trace.getSpan(context.active());
  if (!span || !span.isRecording()) return;

  span.setAttributes(toSpanAttributes(fields));
}

/**
 * Marks the active span as failed and attaches the exception.
 *
 * Both halves matter and they are separate operations in the API: the status
 * is what a backend counts to produce an error rate, and the exception event
 * is what it renders as a stack. Recording one without the other gives either
 * an error you cannot diagnose or a stack trace on a span that reports success.
 */
export function recordSpanException(error: unknown, message?: string): void {
  const span = trace.getSpan(context.active());
  if (!span || !span.isRecording()) return;

  const serialised = serialiseError(error);

  // recordException writes the exception.* convention itself — type, message
  // and stacktrace — as a span event. Setting them again as attributes would
  // duplicate all three, the stack included.
  span.recordException({
    name: serialised.type,
    message: serialised.message,
    stack: serialised.stack,
  });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: message ?? serialised.message,
  });
}

/**
 * Runs `fn` inside a new span, recording its duration and any exception.
 *
 * For the boundaries no instrumentation covers: outbound calls to R2, Google,
 * the payment provider, the AI service, and the expensive internal steps worth
 * seeing separately on a waterfall. An instrumented Postgres query already has
 * its own span and does not need wrapping.
 *
 * The span ends in a finally, so a throw cannot leak one — an unended span is
 * never exported, and the trace it belonged to arrives incomplete with no
 * indication that anything is missing.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      recordSpanException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
