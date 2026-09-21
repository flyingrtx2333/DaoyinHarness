import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

const output = process.argv[2];
if (process.platform !== "linux" || !output?.startsWith("/opt/daoyin-resources/releases/")) {
  throw new Error("Use the independent Linux server and an explicit resource release path.");
}
await mkdir(output, { recursive: true });
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
  outdir: output, outExtension: { ".js": ".mjs" }, external: ["pg"] });
const policy = await import(`${output}/policy.mjs`);
await writeFile(`${output}/tool-schemas.json`, JSON.stringify(Object.entries(policy.RESOURCE_DEFINITIONS).map(([name, value]) => ({ name, ...value })), null, 2));
await writeFile(`${output}/schema.sql`, await readFile("packages/server-cloud/src/resources/schema.sql"));
const files = {};
for (const name of ["service.mjs", "executor.mjs", "migrate.mjs", "egress.mjs", "builder.mjs", "deployment.mjs", "policy.mjs", "tool-schemas.json", "schema.sql"]) {
  files[name] = createHash("sha256").update(await readFile(`${output}/${name}`)).digest("hex");
}
const manifest = { sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceState: execFileSync("git", ["diff", "--name-only", "HEAD", "--", "packages/contracts/src/resources.ts", "packages/server-cloud/src/resources", "scripts/build-resource-services.mjs"], { encoding: "utf8" }).trim()
    ? "resource-sources-uncommitted" : "committed-resource-sources",
  builtAt: new Date().toISOString(), files };
await writeFile(`${output}/release.json`, JSON.stringify(manifest, null, 2));
process.stdout.write(`${JSON.stringify(manifest)}\n`);
