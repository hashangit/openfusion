import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Tests share an in-memory/temp SQLite + faux pi-ai providers; run serially
    // to avoid cross-test state collisions in the on-disk ~/.openfusion dir.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
