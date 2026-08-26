/** @type {import('jest').Config} */

/*
  Transform with swc, not ts-jest.

  ts-jest type-checks every file it transforms, which meant jest recompiled
  the whole 67k-line project on every run — a single test file cost ~70s, and
  CI paid for it twice because `npm run typecheck` had already done the same
  work. swc strips types without checking them, so the test run measures
  behaviour and the typecheck step measures types.

  The tradeoff is real and worth naming: a type error no longer fails the test
  run. It fails `npm run typecheck`, which runs ahead of tests both in CI and
  in the pre-commit hook, so nothing reaches a branch unchecked.

  Settings mirror tsconfig.json — target ES2022, module commonjs.
*/
const swcTransform = [
  "@swc/jest",
  {
    jsc: {
      target: "es2022",
      parser: { syntax: "typescript", decorators: false },
      /*
        Hoists jest.mock() above the imports in the same file. @swc/jest sets
        this itself; it is repeated here so the requirement is visible.

        ⚠️ It only recognises a BARE `jest.mock(...)`. Import `jest` from
        @jest/globals and the call compiles to `_globals.jest.mock(...)`, which
        swc leaves exactly where it stands — after the require() it was meant
        to intercept. The mock registers too late, jest serves the real module,
        and the suite passes while testing production code. It fails silently:
        there is no warning, and assertions that happen to hold against the
        real module still go green.

        So, in a suite that calls jest.mock:
          - use the bare `jest` global (typed by @types/jest), NOT the import; and
          - do not dereference an outer `const` inside the factory, because
            hoisting puts the factory above that declaration — use a getter.
        Or sidestep both by loading the module under test with `await import()`
        inside the test body, which is what several suites here do.

        ts-jest handled all of this via babel-plugin-jest-hoist; nothing carried
        it over with the swc switch.
      */
      transform: { hidden: { jest: true } },
    },
    module: { type: "commonjs" },
  },
];

const baseConfig = {
  testEnvironment: "node",
  clearMocks: true,
  restoreMocks: true,
  moduleFileExtensions: ["ts", "js", "mjs", "json"],
  // `.mjs` is in the pattern for the ESM-only dependencies allowed through
  // `transformIgnorePatterns` below — without it those files match no
  // transform and reach node as raw ESM.
  transform: { "^.+\\.(m?[tj]s)$": swcTransform },
  /*
    node_modules is untransformed by default, which breaks on a dependency
    that ships ESM only — better-auth's `plugins/access` is `.mjs`, so any
    suite reaching `src/auth/permissions.ts` died on "Cannot use import
    statement outside a module" before running a single test.

    Listed rather than blanket-disabled: transforming all of node_modules
    would slow every run for the sake of one package. Add a package here when
    it fails this way, not pre-emptively.
  */
  transformIgnorePatterns: ["/node_modules/(?!(better-auth|@better-auth)/)"],
};

module.exports = {
  projects: [
    {
      ...baseConfig,
      displayName: "unit",
      testMatch: ["<rootDir>/__tests__/unit/**/*.test.ts"],
    },
    {
      ...baseConfig,
      displayName: "integration",
      testMatch: ["<rootDir>/__tests__/integration/**/*.test.ts"],
      testTimeout: 30000,
    },
  ],
};
