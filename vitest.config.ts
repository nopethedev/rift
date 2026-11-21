import { defineConfig } from "vitest/config";
import path from "node:path";

const r = (p: string) => path.resolve(import.meta.dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: r("./vitest.server-only.ts") },
      { find: /^@shared\//, replacement: r("./shared") + "/" },
      { find: /^@\//, replacement: r("./src") + "/" },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "worker/**/*.test.ts"],
    environment: "node",
  },
});
