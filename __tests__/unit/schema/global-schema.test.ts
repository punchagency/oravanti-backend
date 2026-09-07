import { describe, expect, it, jest } from "@jest/globals";
import { z } from "zod";

// The vocabulary lives beside a seed that opens a pool at import time. This
// test reads declarations only and must never touch a database.
jest.mock("../../../src/db/client", () => ({ db: {} }));

import { GlobalImmigrationSchema } from "../../../src/lib/schema/global-schema";
import { flattenSchema } from "../../../src/lib/schema/nodes";
import { FIELDS } from "../../../src/db/seeds/aos-case-questionnaire.seed";

const nodes = flattenSchema(GlobalImmigrationSchema);
const byPath = new Map(nodes.map((node) => [node.path, node]));

/**
 * `FIELDS` expanded the way the flattener expands the graph: one entry per
 * leaf, one per list, and a repeat group's sub-fields as `key[].sub`.
 *
 * The `i485.*` keys are excluded deliberately. They are the 117 Part 9
 * eligibility questions, which only the I-485 asks and only the I-485 prints —
 * form-local by design, like the other 1,530 form-local box names, and they
 * bind to no node.
 */
type Declared = { type: string; label: string; options?: readonly string[] };
const seed = new Map<string, Declared>();
for (const [key, field] of Object.entries(
  FIELDS as Record<string, Record<string, any>>,
)) {
  if (key.startsWith("i485.")) continue;
  seed.set(key, {
    type: field.type,
    label: field.formLabel ?? field.question,
    options: field.config?.options,
  });
  for (const sub of field.config?.fields ?? []) {
    seed.set(`${key}[].${sub.key}`, {
      type: sub.type,
      label: sub.label,
      options: sub.options ?? sub.config?.options,
    });
  }
}

describe("the global schema flattens completely", () => {
  /*
    The whole table rests on this. A leaf that walks off the end of the
    flattener is a datum with no node, so nothing can bind to it, so the box it
    was meant to fill prints blank — weeks later, inside a filing, with nothing
    reporting it. `flattenSchema` throws on a node it cannot classify rather
    than skipping it; this pins the count so a silent loss shows up as a number.
  */
  it("emits one node per leaf and one per list, and nothing twice", () => {
    expect(nodes).toHaveLength(155);
    expect(nodes.filter((n) => n.dataType === "repeat_group")).toHaveLength(7);
    expect(new Set(nodes.map((n) => n.path)).size).toBe(nodes.length);
  });

  it("throws rather than skipping a node it cannot classify", () => {
    const rogue = z.object({ beneficiary: z.object({ mystery: z.string() }) });
    expect(() => flattenSchema(rogue)).toThrow(/beneficiary\.mystery/);
  });

  it("marks everything inside a list as repeating, and nothing outside one", () => {
    for (const node of nodes) {
      const inList = node.path.includes("[]") || node.dataType === "repeat_group";
      expect([node.path, node.isRepeating]).toEqual([node.path, inList]);
    }
  });

  it("takes each category from the path, never from anywhere else", () => {
    for (const node of nodes) {
      expect(node.category).toBe(node.path.split(".")[0]);
    }
  });

  it("gives every choice type its options and no other type any", () => {
    const withChoices = ["single_choice", "multiple_choice", "dropdown"];
    for (const node of nodes) {
      if (withChoices.includes(node.dataType)) {
        expect(node.options?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(node.options).toBeUndefined();
      }
    }
  });
});

/*
  ─── The lock between the two declarations ──────────────────────────────────

  Until the questionnaire seed stops declaring the vocabulary itself, `FIELDS`
  and `global-schema.ts` both say what a datum is called and how it is asked.
  Two hand-written lists of the same thing is exactly the arrangement that made
  the old `FORMS` constant dangerous: it drifted from the real form, and a box
  nobody thought to type up could never be filled.

  These assertions make drift a failing test rather than a blank box. Order is
  deliberately not compared — the graph is written domain by domain, while
  `FIELDS` grew in editing order — but membership, label, type and options are.
*/
describe("the schema and the questionnaire seed agree", () => {
  it("names exactly the same data", () => {
    expect([...seed.keys()].filter((p) => !byPath.has(p))).toEqual([]);
    expect([...byPath.keys()].filter((p) => !seed.has(p))).toEqual([]);
  });

  it("agrees on every label, type and option list", () => {
    const mismatches: string[] = [];
    for (const [path, declared] of seed) {
      const node = byPath.get(path);
      if (!node) continue;
      if (node.dataType !== declared.type) {
        mismatches.push(`${path}: type ${declared.type} vs ${node.dataType}`);
      }
      if (node.label !== declared.label) {
        mismatches.push(`${path}: label ${declared.label} vs ${node.label}`);
      }
      if (
        JSON.stringify(node.options ?? null) !==
        JSON.stringify(declared.options ?? null)
      ) {
        mismatches.push(`${path}: options differ`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
