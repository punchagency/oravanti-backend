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
        Hoists jest.mock() above the imports in the same file, which is what
        makes it intercept anything.

        Without it, swc's commonjs transform emits the require() calls first
        and the jest.mock() registration runs afterwards — too late, so the
        test silently exercises the real module. Suites got away with it only
        by using `await import()` inside the test body. ts-jest did this via
        babel-plugin-jest-hoist; nothing carried it over with the swc switch.
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
  moduleFileExtensions: ["ts", "js", "json"],
  transform: { "^.+\\.(t|j)s$": swcTransform },
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
