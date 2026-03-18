import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@api": path.resolve(__dirname, "./src/api"),
      "@core": path.resolve(__dirname, "./src/core"),
      "@shell": path.resolve(__dirname, "./src/shell"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "extensions/**/*.test.ts"],
    environment: "jsdom",
  },
});
