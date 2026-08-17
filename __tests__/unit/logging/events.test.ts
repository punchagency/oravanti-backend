import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  LogEvent,
  LOG_EVENT_NAMES,
  describeEvent,
  domainOf,
} from "../../../src/lib/logging/events";
import {
  createModuleLogger,
  logAction,
  logFailure,
  logInfo,
  logWarning,
} from "../../../src/lib/logging/log";
import { captureLogs, type LogCapture } from "./capture";

/**
 * The catalogue and the helpers that consume it.
 *
 * The point of a catalogue is that it stays coherent as the app grows, so the
 * naming rules are enforced here rather than left to review. An event that
 * breaks the convention is not a style problem: `domain` is derived from the
 * name, so a malformed event silently lands in the wrong bucket.
 */

let logs: LogCapture;

describe("the event catalogue", () => {
  it("is not empty and every entry is unique", () => {
    // A duplicated string means two call sites are indistinguishable in the
    // log while looking distinct in the code.
    expect(LOG_EVENT_NAMES.length).toBeGreaterThan(0);
    expect(new Set(LOG_EVENT_NAMES).size).toBe(LOG_EVENT_NAMES.length);
  });

  it("names every event domain.action in lower_snake", () => {
    const malformed = LOG_EVENT_NAMES.filter(
      (name) => !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name),
    );

    expect(malformed).toEqual([]);
  });

  it("keys every entry as the SCREAMING_SNAKE of its value", () => {
    // Keeps the constant findable from a log line and back: seeing
    // `lead.stage_changed` in a dashboard, LEAD_STAGE_CHANGED is greppable.
    const mismatched = Object.entries(LogEvent).filter(
      ([key, value]) => key !== value.replace(/\./g, "_").toUpperCase(),
    );

    expect(mismatched).toEqual([]);
  });

  it("derives the domain from the part before the dot", () => {
    expect(domainOf("queue.job_failed")).toBe("queue");
    expect(domainOf("ai_scan.completed")).toBe("ai_scan");
    expect(domainOf("nodots")).toBe("nodots");
  });

  it("derives readable prose for a record with no message", () => {
    expect(describeEvent(LogEvent.AI_SCAN_ISSUE_SYNC_FAILED)).toBe(
      "ai scan issue sync failed",
    );
  });
});

describe("the log helpers", () => {
  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it("stamps event and domain on every record", () => {
    logInfo(LogEvent.EMAIL_SENT, { to: "a@b.test" });

    expect(logs.only()).toMatchObject({
      event: "email.sent",
      domain: "email",
      to: "a@b.test",
      level: "info",
    });
  });

  it("falls back to prose derived from the event", () => {
    logInfo(LogEvent.QUEUE_WORKERS_STARTED);

    expect(logs.only().message).toBe("queue workers started");
  });

  it("prefers an explicit message when one is given", () => {
    logInfo(LogEvent.APP_STARTED, { port: 4000 }, "app listening on port 4000");

    expect(logs.only().message).toBe("app listening on port 4000");
  });

  it("logs a warning at warn", () => {
    logWarning(LogEvent.AI_SCAN_RESULT_ORPHANED, { jobId: "job-1" });

    expect(logs.only()).toMatchObject({ level: "warn", jobId: "job-1" });
  });

  describe("logFailure", () => {
    it("attaches the error with its stack", () => {
      logFailure(LogEvent.EMAIL_SEND_FAILED, new TypeError("no transport"), {
        to: "a@b.test",
      });

      const record = logs.only();
      expect(record.level).toBe("error");
      expect(record.err).toMatchObject({
        type: "TypeError",
        message: "no transport",
      });
      expect(record.err.stack).toContain("no transport");
    });

    it("omits err entirely when there is no error to attach", () => {
      // `"err": null` reads as "we looked and there was nothing", which is a
      // different claim from "this failure had no exception".
      logFailure(LogEvent.PAYMENT_WEBHOOK_REJECTED, undefined, { id: "evt-1" });

      expect(logs.only()).not.toHaveProperty("err");
    });
  });

  it("marks a user action so it can be separated from diagnostics", () => {
    logAction(LogEvent.CASE_CREATED, { caseId: "case-1" });

    expect(logs.only()).toMatchObject({
      kind: "action",
      event: "case.created",
      level: "info",
      caseId: "case-1",
    });
  });

  it("redacts a secret passed in fields, whatever the helper", () => {
    logInfo(LogEvent.AUTH_LOGIN, { email: "a@b.test", password: "hunter2" });

    const record = logs.only();
    expect(record.password).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });
});

describe("createModuleLogger", () => {
  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it("binds the module so a record says which service wrote it", () => {
    const log = createModuleLogger("leads.service");
    log.warn(LogEvent.LEAD_PIPELINE_TEMPLATE_MISSING, { leadId: "lead-1" });

    expect(logs.only()).toMatchObject({
      module: "leads.service",
      event: "lead.pipeline_template_missing",
      leadId: "lead-1",
    });
  });

  it("binds it on the failure path too, where it matters most", () => {
    const log = createModuleLogger("queue.reminder_worker");
    log.failure(LogEvent.QUEUE_JOB_FAILED, new Error("boom"), { jobId: "j-1" });

    expect(logs.only()).toMatchObject({
      module: "queue.reminder_worker",
      level: "error",
      jobId: "j-1",
    });
  });

  it("marks actions from a module as actions", () => {
    const log = createModuleLogger("cases.service");
    log.action(LogEvent.CASE_CLOSED, { caseId: "case-1" });

    expect(logs.only()).toMatchObject({
      module: "cases.service",
      kind: "action",
      event: "case.closed",
    });
  });
});
