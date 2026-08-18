import { describe, expect, it } from "@jest/globals";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every validation module must survive being imported.
 *
 * This exists because of a real defect that reached a running process: zod v4
 * throws `.omit() cannot be used on object schemas containing refinements`
 * from inside `.omit()` itself — at **module load**, not at validation time.
 * Nothing caught it. `tsc` is happy, because the method exists on the type.
 * The unit suite was happy, because nothing imported the module. The route
 * tests were happy, because there are none. It surfaced only when the server
 * booted and the process exited.
 *
 * `.partial()`, `.pick()` and `.extend()` carry the same restriction, so this
 * is a class of bug rather than one mistake, and the cheapest possible guard
 * is to import every one of these files and see whether it explodes.
 */

const MODULES_ROOT = join(__dirname, "..", "..", "..", "src", "modules");
const SHARED_VALIDATION = join(__dirname, "..", "..", "..", "src", "validation");

/** Every `*.validation.ts` under a root, at any depth. */
function findValidationFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".validation.ts")) {
        found.push(full);
      }
    }
  };

  walk(root);
  return found;
}

const validationFiles = [
  ...findValidationFiles(MODULES_ROOT),
  ...findValidationFiles(SHARED_VALIDATION),
].sort();

/** Repo-relative and forward-slashed, so the test name is readable on Windows. */
const label = (file: string) =>
  relative(join(__dirname, "..", "..", ".."), file).split(sep).join("/");

describe("validation modules", () => {
  // A silent zero would make this suite pass by finding nothing, which is the
  // one outcome that would be worse than failing.
  it("finds validation files to check", () => {
    expect(validationFiles.length).toBeGreaterThan(10);
  });

  it.each(validationFiles.map((file) => [label(file), file]))(
    "%s loads without throwing",
    async (_name, file) => {
      await expect(import(file)).resolves.toBeDefined();
    },
  );
});
