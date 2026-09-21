import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

const target = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!target?.endsWith(".json")) throw new Error("Provide an explicit JSON output path.");
const temporary = resolve(".cache", `resource-policy-${process.pid}.mjs`);
await mkdir(dirname(temporary), { recursive: true }); await mkdir(dirname(target), { recursive: true });
try {
  await build({ entryPoints: ["packages/server-cloud/src/resources/tools.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: temporary, external: ["pg"] });
  const policy = await import(`${pathToFileURL(temporary).href}?v=${Date.now()}`);
  const schemas = Object.entries(policy.RESOURCE_DEFINITIONS).map(([name, value]) => ({ name, ...value }));
  await writeFile(target, `${JSON.stringify(schemas, null, 2)}\n`);
} finally { await rm(temporary, { force: true }); }
