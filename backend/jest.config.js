/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],

  // Builds the test schema by running the REAL migrations — see the file for
  // why that matters more than it might look.
  globalSetup: '<rootDir>/tests/globalSetup.ts',

  // Runs before anything imports src/config/env.ts, so its assignments win over
  // backend/.env — which is what lets the suite run with no Stripe credentials.
  setupFiles: ['<rootDir>/tests/setEnv.ts'],

  // Sequential, not parallel. Jest workers are separate processes with separate
  // connection pools, and these tests share one database: parallel workers would
  // delete each other's rows between cases. The concurrency this suite proves
  // is created deliberately inside individual tests via Promise.all, which is
  // real concurrency against real row locks — not an artefact of the runner.
  maxWorkers: 1,

  // Row locks mean a genuinely stuck test blocks rather than fails fast.
  testTimeout: 30_000,

  clearMocks: true,
  verbose: true,
};
