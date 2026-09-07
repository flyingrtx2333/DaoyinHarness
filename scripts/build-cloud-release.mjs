import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

// Read committed source directly: shared-checkout WIP never enters the artifact.
// An independent server clone is not a Windows/WSL shared checkout.
if (process.platform !== "win32" && !(process.platform === "linux" && process.argv.includes("--server-linux") && !process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME)) {
  throw new Error("Use Windows or explicitly pass --server-linux in an independent Linux server clone.");
}
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
  entryPoints: { main: "packages/server-cloud/src/main.ts", "postgres-migrate": "packages/server-cloud/src/postgres-migrate.ts", "sqlite-to-postgres": "packages/server-cloud/src/sqlite-to-postgres.ts", evaluation: "packages/server-cloud/src/evaluation/main.ts" }, bundle: true, platform: "node",
  format: "esm", target: "node22", outdir: output, outExtension: { ".js": ".mjs" },
  plugins: [{ name: "committed-source", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith("node:") || ["fastify", "@fastify/websocket", "pg"].includes(args.path)) return { path: args.path, external: true };
      const path = aliases[args.path] ?? (args.kind === "entry-point" ? posix.normalize(args.path) :
        args.path.startsWith(".") ? posix.join(posix.dirname(args.importer), args.path).replace(/\.js$/u, ".ts") : undefined);
      if (!path || !path.startsWith("packages/") || path.includes("..")) throw new Error(`Unexpected cloud dependency: ${args.path}`);
      return { path, namespace: "committed" };
    });
    builder.onLoad({ filter: /.*/, namespace: "committed" }, (args) => ({ contents: read(args.path), loader: "ts" }));
  } }],
});
const lock = JSON.parse(read("package-lock.json"));
const manifest = { name: "daoyin-cloud-runtime", private: true,
  type: "module", engines: { node: "22.x" }, dependencies: {
    fastify: lock.packages["node_modules/fastify"].version,
    "@fastify/websocket": lock.packages["node_modules/@fastify/websocket"].version,
    pg: lock.packages["node_modules/pg"].version,
  } };
// Preserve the committed versions and integrity hashes, excluding workspace/dev packages.
const packages = { "": manifest };
function include(name, from = "") {
  let parent = from;
  let key;
  while (true) {
    key = `${parent ? `${parent}/` : ""}node_modules/${name}`;
    if (lock.packages[key]) break;
    if (!parent) throw new Error(`Missing locked runtime dependency: ${name}`);
    parent = parent.includes("/node_modules/") ? parent.slice(0, parent.lastIndexOf("/node_modules/")) : "";
  }
  if (packages[key]) return;
  const entry = { ...lock.packages[key] };
  delete entry.dev; delete entry.devOptional;
  if (entry.link) throw new Error(`Unexpected runtime workspace link: ${key}`);
  packages[key] = entry;
  for (const dependency of Object.keys(entry.dependencies ?? {})) include(dependency, key);
  for (const dependency of Object.keys(entry.optionalDependencies ?? {})) include(dependency, key);
  for (const dependency of Object.keys(entry.peerDependencies ?? {})) {
    if (!entry.peerDependenciesMeta?.[dependency]?.optional) include(dependency, key);
  }
}
for (const name of Object.keys(manifest.dependencies)) include(name);
await writeFile(`${output}/package.json`, JSON.stringify(manifest, null, 2));
await writeFile(`${output}/package-lock.json`, JSON.stringify({ name: manifest.name, lockfileVersion: 3, requires: true, packages }, null, 2));
const files = {};
for (const name of ["main.mjs", "postgres-migrate.mjs", "sqlite-to-postgres.mjs", "evaluation.mjs", "package.json", "package-lock.json"]) {
  files[name] = createHash("sha256").update(await readFile(`${output}/${name}`)).digest("hex");
}
await writeFile(`${output}/release.json`, JSON.stringify({ revision, node: "22.23.2", entry: "main.mjs", files, builtAt: new Date().toISOString() }, null, 2));
console.log(output);
