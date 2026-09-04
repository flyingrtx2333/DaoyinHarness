import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is unavailable; run through npm run package:verify.");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim()}`));
      }
    });
  });
}

async function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Packed runtime did not start in time: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/u);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Packed runtime exited before readiness with ${String(code)}: ${stderr}`));
    });
  });
}

const repositoryRoot = process.cwd();
const validationRoot = await mkdtemp(join(tmpdir(), "daoyin-harness-pack-verify-"));
let runtime;

try {
  const packJson = await run(
    process.execPath,
    [npmCli, "pack", "--workspace", "@daoyin/harness", "--pack-destination", validationRoot, "--json"],
    repositoryRoot,
  );
  const packReports = JSON.parse(packJson);
  if (!Array.isArray(packReports) || packReports.length !== 1) {
    throw new Error("Expected one packed artifact.");
  }

  const tarball = join(validationRoot, packReports[0].filename);
  const installRoot = join(validationRoot, "install");
  await run(
    process.execPath,
    [npmCli, "install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    repositoryRoot,
  );

  const packageRoot = join(installRoot, "node_modules", "@daoyin", "harness");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@daoyin/harness" || typeof manifest.version !== "string") {
    throw new Error("Installed package identity is invalid.");
  }

  const entry = join(packageRoot, "dist", "index.js");
  const version = await run(process.execPath, [entry, "--version"], repositoryRoot);
  if (version !== manifest.version) {
    throw new Error(`CLI version mismatch: expected ${manifest.version}, received ${version}.`);
  }

  runtime = spawn(
    process.execPath,
    [entry, "--no-open", "--data-dir", join(validationRoot, "runtime"), "--log-level", "silent"],
    {
      cwd: validationRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await waitForUrl(runtime);
  const response = await fetch(`${url}/api/v1/health`);
  const health = await response.json();
  if (!response.ok || health.status !== "ready" || health.version !== manifest.version) {
    throw new Error(`Packed health verification failed with HTTP ${String(response.status)}.`);
  }

  console.log(`Packed install verified: ${manifest.name}@${manifest.version} at ${url}.`);
} finally {
  if (runtime !== undefined && runtime.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      runtime.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      runtime.kill("SIGTERM");
    });
  }
  await rm(validationRoot, { recursive: true, force: true });
}
