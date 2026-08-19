import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/*
  The backend had no linter at all, which is why `no-console` — specified in
  Phase 1 step 10 of the plan — had nothing to enforce it once the 86
  application-code console calls were migrated to the structured logger.

  Deliberately narrow. This is a gate against regression, not a style pass on
  67k lines: the rules below are the ones whose violation means a real defect
  or a real hole in observability. Formatting is not litigated here.
*/
export default defineConfig([
  globalIgnores(["dist", "drizzle", "coverage"]),

  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      /*
        A leading underscore marks a binding that is deliberately unused — a
        parameter kept to satisfy a signature, a discarded destructured field.
        Matches the frontend config so the convention is one convention.
      */
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          /*
            `const { secret, ...rest } = obj` names `secret` for the sole
            purpose of leaving it out of `rest`. The binding is unused by
            design and deleting it silently changes what the object holds.
          */
          ignoreRestSiblings: true,
        },
      ],

      /*
        Held at "warn" with a ceiling, same treatment as the frontend. The
        backend's `any`s are concentrated in drizzle query builders and
        better-auth callback payloads, neither of which has a cheap type.
        The count is the ceiling — if it rises, the gate is broken even
        though CI stays green.
      */
      "@typescript-eslint/no-explicit-any": "warn",

      /*
        Express types a handler's params and query as `{}` when a route has
        neither — `Request<{}, {}, Body>` is the shape its own .d.ts uses.
        The rule's advice (`object`, `unknown`) does not fit a generic
        argument position that express itself declares this way, and the
        alternative is 40 inline disables saying the same thing.
      */
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowObjectTypes: "always" },
      ],

      /*
        `catch {}` with an empty block is usually a real swallowed failure.
        An intentional one writes `catch { /* why *​/ }`, which this allows.
      */
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },

  {
    /*
      Phase 1 step 10, enforced.

      Application code logs through `createModuleLogger`, which carries the
      requestId that ties a line to its trace and its audit rows. A bare
      console.log has none of that and does not honour redaction — the
      logger's redact layer is a security control, and console bypasses it
      entirely. `rawUserDEK` is a live encryption key sitting in
      RequestContext; one `console.log(ctx)` emits it.

      Scoped to the request path only. Seeds, scripts and cli.ts are terminal
      programs where console output *is* the user interface (D6 in the plan),
      and index.ts / telemetry bootstrap run before the logger exists.
    */
    files: ["src/modules/**/*.ts", "src/middleware/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },

  {
    /*
      An ANSI escape sequence begins with a literal control character, so a
      regex that strips colour has to contain one. The rule is right in
      general and wrong for exactly these two files.
    */
    files: ["src/lib/logging/pretty.ts", "__tests__/unit/logging/pretty.test.ts"],
    rules: { "no-control-regex": "off" },
  },

  {
    // Checks and tests are terminal programs and assertion harnesses.
    files: ["scripts/**/*.ts", "__tests__/**/*.ts", "src/db/seeds/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
]);
