/**
 * Tier 0 — pure logic, no Postgres or Redis.
 *
 * Covers the three modules the whole diff engine rests on: the two-tier
 * fingerprint, value normalisation, and the rules engine.
 */
import {
  computeFingerprint,
  contentHash,
  issueKey,
} from "../../src/modules/case-review/fingerprint";
import {
  normalizeDate,
  normalizeText,
  normalizeValue,
} from "../../src/modules/case-review/normalize";
import { check, checkEqual, report, section } from "./_bootstrap";

const main = async () => {
  section("fingerprint — issueKey identity");

  const base = {
    scenarioId: "scenario-1",
    issueType: "field_conflict",
    field: "date_of_birth",
    documentIds: ["doc-a", "doc-b"],
  };

  checkEqual(
    "same input is stable across calls",
    issueKey(base),
    issueKey({ ...base }),
  );

  checkEqual(
    "documentIds order does not affect the key",
    issueKey(base),
    issueKey({ ...base, documentIds: ["doc-b", "doc-a"] }),
  );

  check(
    "different field yields a different key",
    issueKey(base) !== issueKey({ ...base, field: "full_name" }),
  );

  check(
    "different issueType yields a different key",
    issueKey(base) !== issueKey({ ...base, issueType: "missing_document" }),
  );

  check(
    "different scenario yields a different key",
    issueKey(base) !== issueKey({ ...base, scenarioId: "scenario-2" }),
  );

  check(
    "absent field is distinct from empty-string field",
    issueKey({ ...base, field: undefined }) === issueKey({ ...base, field: "" }),
  );

  section("fingerprint — contentHash revision");

  checkEqual(
    "same salient values hash equally",
    contentHash({ a: "1", b: "2" }),
    contentHash({ a: "1", b: "2" }),
  );

  checkEqual(
    "key order does not affect the content hash",
    contentHash({ a: "1", b: "2" }),
    contentHash({ b: "2", a: "1" }),
  );

  check(
    "changed value changes the content hash",
    contentHash({ a: "1" }) !== contentHash({ a: "2" }),
  );

  const fp = computeFingerprint(base);
  check(
    "computeFingerprint returns both tiers",
    typeof fp.issueKey === "string" &&
      typeof fp.contentHash === "string" &&
      fp.issueKey.length > 0,
    fp,
  );

  section("normalize — text");

  checkEqual("diacritics are stripped", normalizeText("José"), normalizeText("Jose"));
  checkEqual("case is folded", normalizeText("SMITH"), normalizeText("smith"));
  checkEqual(
    "surrounding whitespace is ignored",
    normalizeText("  Ana  "),
    normalizeText("Ana"),
  );

  section("normalize — dates");

  checkEqual("ISO passes through", normalizeDate("1990-04-17"), "1990-04-17");
  checkEqual(
    "US format normalises to ISO",
    normalizeDate("04/17/1990"),
    "1990-04-17",
  );

  // The date-like gate: bare numbers must not be coerced into dates, otherwise a
  // passport number or a year would be compared as a timestamp.
  checkEqual("a bare year is not a date", normalizeDate("2020"), null);
  checkEqual("a bare month number is not a date", normalizeDate("12"), null);
  checkEqual("free text is not a date", normalizeDate("not a date"), null);

  section("normalize — normalizeValue dispatch");

  checkEqual(
    "date-shaped values normalise as dates",
    normalizeValue("04/17/1990"),
    normalizeValue("1990-04-17"),
  );

  checkEqual(
    "name values normalise as text",
    normalizeValue("José  SMITH"),
    normalizeValue("jose smith"),
  );

  await report();
};

void main();
