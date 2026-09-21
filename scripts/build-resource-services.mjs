import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix } from "node:path";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

const output = process.argv[2];
if (process.platform !== "linux" || !output?.startsWith("/opt/daoyin-resources/releases/")) {
  throw new Error("Use the independent Linux server and an explicit resource release path.");
}
await mkdir(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const revision = git("rev-parse", "HEAD").trim();
const aliases = {
  "@daoyin/harness-agent-core": "packages/agent-core/src/index.ts",
  "@daoyin/harness-contracts": "packages/contracts/src/index.ts",
  "@daoyin/harness-protocol": "packages/protocol/src/index.ts",
  "@daoyin/harness-tools/registry": "packages/tools/src/registry.ts",
};
const committedSource = {
  name: "committed-resource-source",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith("node:") || ["fastify", "@fastify/websocket", "pg"].includes(args.path)) {
        return { path: args.path, external: true };
      }
      const sourcePath = aliases[args.path] ?? (args.kind === "entry-point" ? posix.normalize(args.path) :
        args.path.startsWith(".") ? posix.join(posix.dirname(args.importer), args.path).replace(/\.js$/u, ".ts") : undefined);
      if (!sourcePath || !sourcePath.startsWith("packages/") || sourcePath.includes("..")) {
        throw new Error(`Unexpected resource dependency: ${args.path}`);
      }
      return { path: sourcePath, namespace: "committed-resource" };
    });
    builder.onLoad({ filter: /.*/, namespace: "committed-resource" }, (args) => ({
      contents: git("show", `${revision}:${args.path}`),
      loader: "ts",
    }));
  },
};
const entries = {
  service: "packages/server-cloud/src/resources/service.ts",
  executor: "packages/server-cloud/src/resources/executor.ts",
  migrate: "packages/server-cloud/src/resources/migrate.ts",
  egress: "packages/server-cloud/src/resources/egress.ts",
  builder: "packages/server-cloud/src/resources/builder.ts",
  deployment: "packages/server-cloud/src/resources/deployment.ts",
  policy: "packages/server-cloud/src/resources/tools.ts",
};
await build({ entryPoints: entries, bundle: true, platform: "node", format: "esm", target: "node22",
  outdir: output, outExtension: { ".js": ".mjs" }, plugins: [committedSource] });
const policy = await import(`${output}/policy.mjs`);
await writeFile(`${output}/tool-schemas.json`, JSON.stringify(Object.entries(policy.RESOURCE_DEFINITIONS).map(([name, value]) => ({ name, ...value })), null, 2));
await writeFile(`${output}/schema.sql`, await readFile("packages/server-cloud/src/resources/schema.sql"));
const files = {};
for (const name of ["service.mjs", "executor.mjs", "migrate.mjs", "egress.mjs", "builder.mjs", "deployment.mjs", "policy.mjs", "tool-schemas.json", "schema.sql"]) {
  files[name] = createHash("sha256").update(await readFile(`${output}/${name}`)).digest("hex");
}
const manifest = { sourceRevision: revision,
  sourceState: execFileSync("git", ["diff", "--name-only", "HEAD", "--", "packages/contracts/src/resources.ts", "packages/server-cloud/src/resources", "scripts/build-resource-services.mjs"], { encoding: "utf8" }).trim()
    ? "resource-sources-uncommitted" : "committed-resource-sources",
  builtAt: new Date().toISOString(), files };
await writeFile(`${output}/release.json`, JSON.stringify(manifest, null, 2));
process.stdout.write(`${JSON.stringify(manifest)}\n`);
