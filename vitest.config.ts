import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@daoyin/harness-protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@daoyin/harness-server": fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
      "@daoyin/harness-workspace": fileURLToPath(new URL("./packages/workspace/src/index.ts", import.meta.url)),
      "@daoyin/harness-process": fileURLToPath(new URL("./packages/process/src/index.ts", import.meta.url)),
      "@daoyin/harness-tools": fileURLToPath(new URL("./packages/tools/src/index.ts", import.meta.url)),
      "@daoyin/harness-agent-core": fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
      "@daoyin/harness-cloud": fileURLToPath(new URL("./packages/cloud/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["claude-code-main/**", "**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
