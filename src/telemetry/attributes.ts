import type { Attributes } from "@opentelemetry/api";

/**
 * Coercion for **span** attributes.
 *
 * Log records need nothing like this: `LogAttributes` is an `AnyValueMap`, so
 * a nested object is a legal attribute value and the log bridge passes records
 * through exactly as they were written. Span attributes are the stricter of
 * the two — primitives and homogeneous arrays only — so a structured field has
 * to be flattened to survive at all.
 *
 * Names are never translated. A field called `requestId` becomes an attribute
 * called `requestId`. The fields with genuine semantic conventions —
 * `http.request.method`, `url.path`, `client.address` — are set by the HTTP
 * instrumentation on the same span, from the request itself, so there is
 * nothing here for a mapping table to do that is not already done properly by
 * something closer to the source.
 */

/** Deep enough for the payloads this app logs; a guard, not a limit to reach. */
const MAX_DEPTH = 5;

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * Flattens nested objects into dotted keys — `details.source`, not a JSON
 * blob. The distinction matters at query time: a flattened key is filterable,
 * and a stringified object can only be grepped.
 *
 * A mixed array is JSON-encoded rather than dropped, because a rejected
 * attribute value takes the whole span's usefulness with it and a string is at
 * least readable.
 */
export function toSpanAttributes(
  fields: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Attributes {
  const out: Attributes = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;

    const name = prefix ? `${prefix}.${key}` : key;

    if (isPrimitive(value)) {
      out[name] = value;
      continue;
    }

    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === typeof value[0] && isPrimitive(v))) {
        out[name] = value as string[] | number[] | boolean[];
      } else {
        out[name] = JSON.stringify(value);
      }
      continue;
    }

    if (typeof value === "object" && depth < MAX_DEPTH) {
      Object.assign(
        out,
        toSpanAttributes(value as Record<string, unknown>, name, depth + 1),
      );
      continue;
    }

    out[name] = String(value);
  }

  return out;
}
