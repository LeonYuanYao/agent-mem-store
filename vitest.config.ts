import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 8,
    // Tests that start the CLI pay about 3 s of tsx startup per call, more on a loaded machine.
    testTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true
  }
});
