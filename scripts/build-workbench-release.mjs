import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const { build } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("esbuild");

if (process.platform !== "win32") throw new Error("Build releases from Windows.");
const preview = process.argv.includes("--preview");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const revision = git("rev-parse", "HEAD").trim();
const root = resolve(".");
const read = (path) => preview ? readFile(resolve(path), "utf8") : Promise.resolve(git("show", `${revision}:${path}`));
const output = resolve(".cache", "workbench-release", preview ? "preview" : revision);
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: ["packages/ui/src/cloud/main.tsx"], bundle: true, platform: "browser", format: "esm", target: "es2022",
  outdir: `${output}/assets`, entryNames: "workbench-[hash]", minify: true, jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, metafile: true, legalComments: "eof",
  plugins: [{ name: "committed-workbench-source", setup(builder) {
    builder.onLoad({ filter: /packages[\\/]ui[\\/]src[\\/]/ }, async (args) => {
      const path = relative(root, args.path).replaceAll("\\", "/");
      if (!path.startsWith("packages/ui/src/cloud/") && path !== "packages/ui/src/MarkdownMessage.tsx") throw new Error(`Unexpected UI source: ${path}`);
      return { contents: await read(path), loader: extname(path).slice(1), resolveDir: resolve(args.path, "..") };
    });
  } }],
});
// All installed dependencies actually used by this bundle must match the committed lock.
const lock = JSON.parse(await read("package-lock.json"));
const checked = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll("\\", "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u);
  if (!match || checked.has(match[1])) continue;
  const path = match[1]; checked.add(path);
  const installed = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
  if (installed.version !== lock.packages[path]?.version) throw new Error(`Installed dependency differs from lock: ${path}`);
}
const outputs = Object.keys(result.metafile.outputs).map((path) => path.replaceAll("\\", "/"));
const js = outputs.find((path) => path.endsWith(".js"))?.split("/").at(-1);
const css = outputs.find((path) => path.endsWith(".css"))?.split("/").at(-1);
if (!js || !css) throw new Error("Workbench assets missing");
await writeFile(`${output}/index.html`, `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f6f7f9"><meta name="description" content="道引 Harness 云端工作台：公开知识问答、会话与资料引用。"><title>道引 Harness 工作台</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/harness/assets/${css}"><script type="module" src="/harness/assets/${js}"></script></head><body><div id="root"></div><noscript>请启用 JavaScript 使用工作台。</noscript></body></html>\n`);
const files = {};
for (const file of ["index.html", `assets/${js}`, `assets/${css}`]) files[file] = createHash("sha256").update(await readFile(`${output}/${file}`)).digest("hex");
await writeFile(`${output}/release.json`, JSON.stringify({ revision, preview, builtAt: new Date().toISOString(), files }, null, 2));
console.log(JSON.stringify({ output, revision, preview, files }, null, 2));
