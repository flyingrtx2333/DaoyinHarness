// Run from Windows PowerShell: node scripts/verify-p0.mjs
// Validation only: no Git writes, releases, production URLs, or provider calls.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("P0 acceptance must run from Windows PowerShell.");
if (process.argv.length !== 2) throw new Error("This runner accepts no database, production, or deployment arguments.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = resolve(root, "..", "DaoyinTechnology");
const id = randomUUID().replaceAll("-", "").slice(0, 16);
const project = `daoyin-p0-${id}`;
const output = resolve(root, ".cache", "p0-validation", id);
mkdirSync(output, { recursive: true });
const report = { schemaVersion: 1, runId: id, platform: "win32", nodeVersion: process.versions.node, startedAt: new Date().toISOString(),
  status: "running", stages: [], sourceBefore: null, sourceAfter: null,
  productionDeployment: "not-performed", realModelCalls: "not-performed", productionBackupRestore: "not-performed" };
const reportPath = resolve(output, "report.json");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const env = { ...process.env };
// Never inherit a cloud/PG test connection or model credential into test processes.
for (const key of Object.keys(env)) if (/^(?:DAOYIN_(?:CLOUD|TEST)|PG[A-Z_]*$|OPENAI_|ANTHROPIC_|DEEPSEEK_|AZURE_OPENAI_|AGENT_(?:PUBLIC|APP)_)/iu.test(key)) delete env[key];
env.PYTHON_DOTENV_DISABLED = "1";
const resources = { network: "", postgres: "", backendStarted: false, backendBuilt: false };
const backendCompose = ["compose", "--project-name", project, "-f", resolve(platform, "backend/docker-compose-agent-test.yml"),
  "-f", resolve(output, "backend-compose.json")];

function command(binary, args, { cwd = root, environment = env, quiet = false, timeout = 15 * 60_000 } = {}) {
  const result = spawnSync(binary, args, { cwd, env: environment, windowsHide: true, encoding: "utf8", timeout,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${binary === process.execPath ? "node" : binary} failed (${result.error?.code ?? result.status ?? "unknown"}).`);
  return (result.stdout ?? "").trim();
}
async function stage(name, action) {
  const entry = { name, status: "running", startedAt: new Date().toISOString(), elapsedMs: 0 };
  report.stages.push(entry); save();
  console.log(`\n[P0] ${name}`);
  const start = performance.now();
  try { const value = await action(); entry.status = "passed"; return value; }
  catch (error) { entry.status = "failed"; throw error; }
  finally { entry.elapsedMs = Math.round(performance.now() - start); save(); }
}
function npm(script, cwd = root) {
  if (!["typecheck", "lint", "build"].includes(script)) throw new Error("Unsupported npm script.");
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& npm.cmd run ${script}; exit $LASTEXITCODE`], { cwd });
}
function fingerprint(cwd, paths) {
  const raw = command("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], { cwd, quiet: true });
  const hash = createHash("sha256");
  const files = [...new Set(raw.split("\0").filter(Boolean))].sort();
  for (const path of files) {
    const file = resolve(cwd, path);
    hash.update(path + "\0");
    if (!existsSync(file)) { hash.update("deleted\0"); continue; }
    const stat = lstatSync(file);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    hash.update(createHash("sha256").update(bytes).digest());
  }
  return { sha256: hash.digest("hex"), files: files.length, head: command("git", ["rev-parse", "HEAD"], { cwd, quiet: true }) };
}
function sources() {
  return {
    harness: fingerprint(root, ["AGENTS.md", ".node-version", ".nvmrc", "package.json", "package-lock.json", "*.config.*", "tsconfig*", "packages", "scripts"]),
    mainPlatform: fingerprint(platform, ["backend/app.py", "backend/config.py", "backend/database.py", "backend/routes", "backend/services",
      "backend/models", "backend/schemas", "backend/tests", "backend/requirements*.txt", "backend/Dockerfile*", "backend/docker-compose-agent-test.yml",
      "frontend/src", "frontend/public", "frontend/index.html", "frontend/package.json", "frontend/package-lock.json", "frontend/*config*"]),
  };
}

try {
  await stage("preflight", () => {
    if (process.versions.node !== readFileSync(resolve(root, ".node-version"), "utf8").trim()) throw new Error("Use the repository-pinned Windows Node version.");
    for (const path of [resolve(root, "node_modules/vitest/vitest.mjs"), resolve(platform, "frontend/node_modules/vitest/vitest.mjs")]) {
      if (!existsSync(path)) throw new Error("Install the locked dependencies from Windows first; this runner does not modify dependency installations.");
    }
    command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { quiet: true });
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("npipe://")) throw new Error("Only a local Windows Docker endpoint is accepted.");
    const dockerHost = command("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { quiet: true, timeout: 15_000 });
    if (!dockerHost.startsWith("npipe://")) throw new Error("Use local Docker Desktop, not a remote Docker context.");
    if (command("docker", ["info", "--format", "{{.OSType}}"], { quiet: true, timeout: 15_000 }) !== "linux") throw new Error("Docker Desktop Linux containers must be running.");
    report.sourceBefore = sources();
  });
  await stage("harness-typecheck", () => npm("typecheck"));
  await stage("harness-lint", () => npm("lint"));
  await stage("harness-tests", () => command(process.execPath, ["node_modules/vitest/vitest.mjs", "run"]));
  await stage("harness-build", () => npm("build"));

  await stage("isolated-postgres-start", async () => {
    resources.network = command("docker", ["network", "create", "--internal", "--label", `com.daoyin.p0-run=${id}`, `${project}-net-dev`], { quiet: true });
    resources.postgres = command("docker", ["run", "--detach", "--name", `${project}-pg-dev`, "--label", `com.daoyin.p0-run=${id}`,
      "--network", resources.network, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=p0", "--env", "POSTGRES_DB=daoyin_p0",
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=512m", "--memory", "768m", "postgres:16-alpine"], { quiet: true });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { command("docker", ["exec", resources.postgres, "pg_isready", "-U", "p0", "-d", "daoyin_p0"], { quiet: true, timeout: 5000 }); ready = true; break; }
      catch { await delay(500); }
    }
    if (!ready) throw new Error("Isolated PostgreSQL did not become ready.");
    const published = command("docker", ["port", resources.postgres, "5432/tcp"], { quiet: true });
    if (!/^127\.0\.0\.1:\d+$/u.test(published)) throw new Error("Unexpected PostgreSQL port mapping.");
    env.DAOYIN_TEST_POSTGRES_URL = `postgresql://p0@${published}/daoyin_p0`;
    env.DAOYIN_P0_CONTAINER = resources.postgres;
    env.DAOYIN_P0_RUN_ID = id;
  });
  await stage("postgres-integration-tests", () => command(process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "packages/server-cloud/src/postgres-repository.test.ts"]));
  await stage("fixture-backup-and-restore", () => command(process.execPath, ["scripts/verify-p0-restore.mjs", resolve(output, "restore.json")]));

  await stage("platform-test-compose-setup", () => {
    writeFileSync(resolve(output, "backend-compose.json"), JSON.stringify({ services: {
      "agent-mysql-dev": { container_name: `${project}-mysql-dev`, labels: { "com.daoyin.p0-run": id } },
      "agent-tests": { container_name: `${project}-backend-dev`, image: `daoyin-p0-backend-dev:${id}`, labels: { "com.daoyin.p0-run": id } },
    } }, null, 2));
    command("docker", [...backendCompose, "config", "--quiet"]);
    command("docker", [...backendCompose, "build", "agent-tests"], { timeout: 30 * 60_000 });
    resources.backendBuilt = true;
    resources.backendStarted = true;
    command("docker", [...backendCompose, "up", "--detach", "--wait", "--wait-timeout", "120", "agent-mysql-dev"]);
  });
  await stage("platform-backend-tests", () => command("docker", [...backendCompose, "run", "--rm", "--no-deps", "agent-tests",
    "python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_harness_p0.py", "tests/test_daoyin_harness.py",
    "tests/test_agent_public.py", "tests/test_agent_event_stream.py", "tests/test_first_party_accounts.py", "tests/test_harness_model_stream.py"]));
  await stage("website-tests", () => command(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
    "src/composables/companyAgent.test.js", "src/composables/companyAgentEvents.test.js"], { cwd: resolve(platform, "frontend") }));
  await stage("website-build", () => npm("build", resolve(platform, "frontend")));
  await stage("websocket-browser-regression", () => command(process.execPath, ["scripts/verify-cloud-websocket.mjs"]));
  await stage("account-browser-regression", () => command(process.execPath,
    ["scripts/verify-account-access.mjs", `--output=${resolve(output, "account-browser")}`]));
  await stage("source-consistency", () => {
    report.sourceAfter = sources();
    if (JSON.stringify(report.sourceBefore) !== JSON.stringify(report.sourceAfter)) throw new Error("Sources changed during validation; do not publish mixed evidence.");
  });
  report.status = "passed-local-validation-only";
} catch (error) {
  report.status = "failed";
  console.error(`[P0] STOP: ${error instanceof Error ? error.message : "validation failed"}`);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  if (resources.backendStarted) cleanup.push(() => command("docker", [...backendCompose, "down", "--volumes"], { quiet: true }));
  if (resources.backendBuilt) cleanup.push(() => command("docker", ["image", "rm", `daoyin-p0-backend-dev:${id}`], { quiet: true }));
  if (resources.postgres) cleanup.push(() => command("docker", ["rm", "--force", resources.postgres], { quiet: true }));
  if (resources.network) cleanup.push(() => command("docker", ["network", "rm", resources.network], { quiet: true }));
  let cleaned = true;
  for (const action of cleanup) try { action(); } catch { cleaned = false; }
  report.cleanup = cleaned ? "completed" : "needs-attention";
  if (!cleaned) { report.status = "failed-cleanup"; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); save();
  console.log(`[P0] ${report.status}. Report: ${reportPath}`);
}
