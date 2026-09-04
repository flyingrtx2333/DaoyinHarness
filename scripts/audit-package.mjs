import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`npm pack exited with code ${String(code)}`));
      }
    });
  });
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is unavailable; run this audit through npm run package:audit.");
}

const raw = await run(process.execPath, [npmCli, "pack", "--workspace", "@daoyin/harness", "--dry-run", "--json"]);
const reports = JSON.parse(raw);
if (!Array.isArray(reports) || reports.length !== 1) {
  throw new Error("Expected exactly one npm pack report.");
}

const report = reports[0];
const paths = report.files.map((file) => file.path.replaceAll("\\", "/"));
const forbidden = paths.filter((path) =>
  path.includes("claude-code-main") ||
  path.endsWith(".map") ||
  /(^|\/)(?:data|sessions|workspaces|checkpoints|previews)(\/|$)/u.test(path) ||
  /(^|\/)(?:\.env|credentials?|secrets?)(\.|\/|$)/iu.test(path),
);

const required = ["dist/index.js", "dist/public/index.html", "package.json"];
const missing = required.filter((path) => !paths.includes(path));
const unexpected = paths.filter((path) => path !== "package.json" && !path.startsWith("dist/"));

if (forbidden.length > 0 || missing.length > 0 || unexpected.length > 0) {
  throw new Error(JSON.stringify({ forbidden, missing, unexpected }, null, 2));
}

console.log(`Package audit passed: ${String(paths.length)} allowlisted files, ${String(report.size)} packed bytes.`);
