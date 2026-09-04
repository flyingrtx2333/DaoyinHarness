import { chmod, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@fastify/static", "@fastify/websocket", "@modelcontextprotocol/client", "fastify", "open", "playwright-core"],
  legalComments: "none",
  logLevel: "info",
});

await chmod("dist/index.js", 0o755);
