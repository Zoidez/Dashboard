import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
});
