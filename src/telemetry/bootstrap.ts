import { startTelemetry } from "./index";

/**
 * Side-effect entrypoint. `import "./telemetry/bootstrap";` as the first line
 * of a process entrypoint, above every other import.
 *
 * It exists as its own module because of a subtlety that is easy to get wrong
 * and impossible to notice afterwards. OpenTelemetry instruments libraries by
 * patching them at require time, so it must run before express, pg or ioredis
 * are loaded. Writing `startTelemetry()` as a statement between two imports
 * looks like it does that, and does not: under ES module semantics every
 * import in a file is evaluated before any of its statements, so the call
 * would land after the modules it was meant to precede. A bare import is
 * ordered — the module it names is fully evaluated before the next import
 * begins — which is the only form that reliably runs first.
 *
 * The symptom of getting it wrong is not an error. It is a telemetry pipeline
 * that starts, reports itself healthy, and produces no spans.
 */
startTelemetry();
