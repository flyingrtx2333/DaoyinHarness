import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, unlink, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32", "Cloud smoke must run from Windows.");
const directory = await mkdtemp(join(tmpdir(), "daoyin-cloud-smoke-"));
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
const child = spawn(process.execPath, ["packages/server-cloud/dist/main.js"], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DAOYIN_CLOUD_DATABASE: join(directory, "pilot.sqlite"), DAOYIN_CLOUD_PORT: String(port),
    DAOYIN_CLOUD_PLATFORM_URL: "http://127.0.0.1:1", DAOYIN_CLOUD_SERVICE_TOKEN: "fixture-only-service-token-000000000000" },
});
let startup = "";
child.stdout.on("data", (data) => { startup += data; });
child.stderr.resume();
try {
  for (let attempt = 0; attempt < 100 && !startup.includes("listening"); attempt += 1) {
    if (child.exitCode !== null) throw new Error("Cloud process exited during startup.");
    await delay(50);
  }
  assert.match(startup, /listening on 127\.0\.0\.1/u);
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(origin + "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).productionReady, false);
  assert.equal((await fetch(origin + "/api/v1/cloud/sessions")).status, 401);
  const denied = await fetch(origin + "/api/v1/cloud/sessions", { headers: { authorization: "Bearer fixture_visitor" } });
  assert.equal(denied.status, 503);
  assert.equal((await denied.text()).includes("fixture-only-service-token"), false);
  process.stdout.write("Cloud startup, loopback HTTP health, missing auth and unavailable-platform denial passed. No real model call.\n");
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill();
    await exited;
  }
  assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + "\\daoyin-cloud-smoke-"), true);
  for (const file of await readdir(directory)) {
    assert.ok(["pilot.sqlite", "pilot.sqlite-wal", "pilot.sqlite-shm"].includes(file));
    await unlink(join(directory, file));
  }
  await rmdir(directory);
}
