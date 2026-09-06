import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

// Read committed source directly: shared-checkout WIP never enters the artifact.
if (process.platform !== "win32") throw new Error("Build releases from Windows.");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const revision = git("rev-parse", "HEAD").trim();
const read = (path) => git("show", `${revision}:${path}`);
const output = resolve(".cache", "cloud-release", revision);
await mkdir(output, { recursive: true });
const aliases = {
  "@daoyin/harness-agent-core": "packages/agent-core/src/index.ts",
  "@daoyin/harness-contracts": "packages/contracts/src/index.ts",
  "@daoyin/harness-protocol": "packages/protocol/src/index.ts",
  "@daoyin/harness-tools/registry": "packages/tools/src/registry.ts",
};
await build({
  entryPoints: ["packages/server-cloud/src/main.ts"], bundle: true, platform: "node",
  format: "esm", target: "node22", outfile: `${output}/main.mjs`,
  plugins: [{ name: "committed-source", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith("node:") || args.path === "fastify") return { path: args.path, external: true };
      const path = aliases[args.path] ?? (args.kind === "entry-point" ? posix.normalize(args.path) :
        args.path.startsWith(".") ? posix.join(posix.dirname(args.importer), args.path).replace(/\.js$/u, ".ts") : undefined);
      if (!path || !path.startsWith("packages/") || path.includes("..")) throw new Error(`Unexpected cloud dependency: ${args.path}`);
      return { path, namespace: "committed" };
    });
    builder.onLoad({ filter: /.*/, namespace: "committed" }, (args) => ({ contents: read(args.path), loader: "ts" }));
  } }],
});
const lock = JSON.parse(read("package-lock.json"));
await writeFile(`${output}/package.json`, JSON.stringify({ name: "daoyin-cloud-runtime", private: true,
  type: "module", engines: { node: "22.x" }, dependencies: { fastify: lock.packages["node_modules/fastify"].version } }, null, 2));
await writeFile(`${output}/package-lock.json`, read("package-lock.json"));
await writeFile(`${output}/release.json`, JSON.stringify({ revision, node: "22.23.2", entry: "main.mjs", builtAt: new Date().toISOString() }, null, 2));
console.log(output);
