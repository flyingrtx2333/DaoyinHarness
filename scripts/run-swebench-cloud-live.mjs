// Controlled inference on three pinned issues using the ordinary cloud account runtime.
// No model requests occur without --run and an exact deployed revision.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCloudAccountClient, readHiddenCredentials, requestCloudObservation, sanitizeEvidence } from "./cloud-live-client.mjs";
import { loadPreparedSources, uploadPreparedSource } from "./swebench-source-upload.mjs";

const root = resolve(import.meta.dirname, "..");
const revision = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
const ids = ["pytest-dev__pytest-5787", "pytest-dev__pytest-5631", "sympy__sympy-12481"];
const sha = value => createHash("sha256").update(value).digest("hex");
const infrastructureFailure = code => /^(?:EGRESS_|SANDBOX_|OCI_|WORKSPACE_(?:SUBNET_|NETWORK_)|RESOURCE_(?:EXECUTOR_|AUDIT_PERSISTENCE_FAILED|SERVICE_FAILED)|PROCESS_CLEANUP_|SWE_(?:BUDGET_|RUNTIME_|UNEXPECTED_DELEGATION|GIT_SETUP_))/u.test(code ?? "");
const args = process.argv.slice(2);
const expected = args[args.indexOf("--expected-revision") + 1];
const selectedInstance = args.includes("--instance") ? args[args.indexOf("--instance") + 1] : undefined;
if (args.length !== (selectedInstance === undefined ? 3 : 5) || !args.includes("--run") ||
    args.indexOf("--expected-revision") < 0 || !/^[a-f0-9]{40}$/u.test(expected ?? "") ||
    (args.includes("--instance") && !ids.includes(selectedInstance))) {
  throw new Error("Use --run --expected-revision FULL_DEPLOYED_COMMIT [--instance PINNED_INSTANCE_ID]; normal account credentials are read through hidden stdin.");
}
const selectedIds = selectedInstance === undefined ? ids : [selectedInstance];
const manifestPath = join(root, ".cache/swebench-verified-3/manifest.json");
const dockerfilePath = join(root, "deployment/resource-runtimes/swe-python/Dockerfile");
const dockerfile = await readFile(dockerfilePath, "utf8");
const dockerfileDigest = sha(dockerfile);
const dockerignore = ".harness/\n.harness-restore-*/\nlost+found/\n";
if (dockerfileDigest !== "0ca8350dddde55125d68f9841643415a0b46f3a76b24cc087a538fafbcf44c4e") {
  throw new Error("The independently authored, pinned Python/Git runtime Dockerfile has changed; review its exact recipe before inference.");
}
const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
if (manifest.datasetRevision !== revision || manifest.dataset !== "princeton-nlp/SWE-bench_Verified" ||
    manifest.referencePatchExposed !== false || manifest.testPatchExposed !== false || manifest.tasks.length !== 3 ||
    manifest.tasks.some((task, index) => task.instance_id !== ids[index] || !/^[a-f0-9]{40}$/u.test(task.base_commit) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(task.repo) || typeof task.problem_statement !== "string" ||
      Object.keys(task).some(key => !["instance_id", "repo", "base_commit", "problem_statement", "version"].includes(key)))) {
  throw new Error("Pinned issue-only manifest provenance mismatch; do not expose full dataset rows to inference.");
}
const preparedSources = await loadPreparedSources({ root, issueManifestText: manifestText, manifest });
const output = join(root, ".cache/swebench-cloud-live", new Date().toISOString().replaceAll(":", "-") + "_" + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { kind: "swebench-verified-cloud-harness-inference", mode: "real", output,
  dataset: manifest.dataset, datasetRevision: revision, datasetSha256: manifest.datasetSha256, manifestSha256: sha(manifestText),
  expectedRuntimeRevision: expected, fakeModels: false, fabricatedBusinessResponses: false,
  sampleIds: ids, selectedIds,
  driverSourceSha256: sha(await readFile(new URL(import.meta.url))),
  transportSourceSha256: sha(await readFile(new URL("./cloud-live-client.mjs", import.meta.url))),
  sourceUploadDriverSourceSha256: sha(await readFile(new URL("./swebench-source-upload.mjs", import.meta.url))),
  runtimeDockerfile: { file: dockerfilePath, sha256: dockerfileDigest,
    base: "mirror.ccs.tencentyun.com/library/python@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26",
    upstreamOriginal: "python@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26",
    builder: "ordinary-account-isolated-Dockerfile-builder" },
  referencePatchExposed: false, testPatchExposed: false, modelCalls: 0, routingModelCalls: 0, sharedModelCalls: 0, usage: "unknown", cost: "unknown",
  modelAccounting: { source: "persisted AgentEngine model.requested events", scope: "AgentEngine attempts only",
    routingSource: "persisted capability.model.requested events", sharedBudgetIncludesRouting: true,
    providerTotalCalls: "unknown; gateway attempts do not prove provider execution or settlement" },
  limits: { cases: selectedIds.length, perCaseModelCalls: 12, totalModelCalls: 12 * selectedIds.length, perCaseMs: 420_000, totalMs: 1_800_000 },
  inferenceEnvironment: "ordinary account cloud API; locally prepared exact-base sources uploaded into independent Python/Git Dockerfile workspaces; isolated builder and gVisor",
  cases: [], status: "preflight", startedAt: new Date().toISOString() };
const predictions = [];
const save = async () => {
  await writeFile(join(output, "report.json"), JSON.stringify(sanitizeEvidence(report), null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(output, "predictions.jsonl"), predictions.map(row => JSON.stringify(row)).join("\n") + (predictions.length ? "\n" : ""), { mode: 0o600 });
};
const accountModelAttempts = (item, events) => {
  item.modelCalls = events.filter(event => event.type === "model.requested").length;
  item.routingModelCalls = events.filter(event => event.type === "capability.model.requested").length;
  item.sharedModelCalls = item.modelCalls + item.routingModelCalls;
  report.modelCalls = report.cases.reduce((sum, observed) => sum + observed.modelCalls, 0);
  report.routingModelCalls = report.cases.reduce((sum, observed) => sum + (observed.routingModelCalls ?? 0), 0);
  report.sharedModelCalls = report.modelCalls + report.routingModelCalls;
};
const controller = new AbortController();
const inferenceDeadline = performance.now() + report.limits.totalMs;
const timer = setTimeout(() => controller.abort(new Error("Cloud inference total deadline exceeded.")), report.limits.totalMs);
const stop = () => controller.abort(new Error("Operator cancelled cloud inference."));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const client = createCloudAccountClient({ signal: controller.signal });
let currentRun;
let observationDeadline;
let stage = "sign-in";
const started = performance.now();
const makeControl = (item, evidenceOutput) => async (action, input = {}, timeoutMs = 120_000) => {
  const operationBegan = performance.now();
  const body = { action, sessionId: item.sessionId,
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), requestId: `swe_${randomUUID().replaceAll("-", "")}`, ...input };
  const operation = { action, at: new Date().toISOString(), requestId: body.requestId, status: "request-persisted" };
  item.operations.push(operation);
  const prefix = `operation-${String(item.operations.length).padStart(4, "0")}-${action}`;
  const requestText = JSON.stringify(sanitizeEvidence({ observedAt: operation.at, endpoint: "/resources/control", request: body }), null, 2) + "\n";
  const requestFile = join(evidenceOutput, `${prefix}-request.json`);
  await writeFile(requestFile, requestText, { flag: "wx", mode: 0o600 });
  operation.requestEvidence = { file: requestFile, sha256: sha(requestText) };
  await save(); // Persist the exact request before a potentially mutating, uncertain POST.
  try {
    const response = await client.request("/resources/control", body, { timeoutMs });
    const receiptText = JSON.stringify(sanitizeEvidence({ observedAt: new Date().toISOString(), endpoint: "/resources/control",
      request: body, response }), null, 2) + "\n";
    const receiptFile = join(evidenceOutput, `${prefix}-response.json`);
    await writeFile(receiptFile, receiptText, { flag: "wx", mode: 0o600 });
    operation.responseEvidence = { file: receiptFile, sha256: sha(receiptText), source: "ordinary-cloud-resource-control-API" };
    operation.status = "response-received";
    operation.httpStatus = response.status;
    operation.resultSha256 = sha(JSON.stringify(response.result));
    if (typeof response.result.exitCode === "number") operation.exitCode = response.result.exitCode;
    await save();
    return response.result;
  } catch (error) {
    const failureText = JSON.stringify(sanitizeEvidence({ observedAt: new Date().toISOString(), endpoint: "/resources/control",
      request: body, failure: { code: error.code ?? error.name, ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) } }), null, 2) + "\n";
    const failureFile = join(evidenceOutput, `${prefix}-failure.json`);
    await writeFile(failureFile, failureText, { flag: "wx", mode: 0o600 });
    operation.failureEvidence = { file: failureFile, sha256: sha(failureText) };
    operation.status = "request-failed-or-receipt-incomplete";
    await save();
    const transportTimeout = error.name === "TimeoutError" ||
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(error.code ?? error.cause?.code);
    if (action === "process_run" && !controller.signal.aborted &&
        (error.publicFailure?.code === "CLOUD_REQUEST_UNCERTAIN" || (transportTimeout && error.publicFailure === undefined))) {
      const commandTimeout = body.timeoutMs ?? timeoutMs;
      const fail = (code, message) => Object.assign(new Error(message), { code });
      if (!Number.isSafeInteger(commandTimeout) || commandTimeout < 100 || commandTimeout > 600_000) {
        throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The original process timeout cannot bound read-only recovery.");
      }
      const deadline = operationBegan + commandTimeout + 30_000;
      operation.recovery = { status: "read-only-pending", originalRequestId: body.requestId,
        mutatingResubmissions: 0, deadlineMs: commandTimeout + 30_000 };
      await save();
      const read = async (readAction, fields) => {
        controller.signal.throwIfAborted();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 100) throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_TIMEOUT", "The original process did not yield a persisted terminal receipt within its bounded deadline.");
        return makeControl(item, evidenceOutput)(readAction, fields, Math.min(15_000, remaining));
      };
      try {
        while (performance.now() < deadline) {
          const inspected = await read("workspace_inspect", { workspaceId: body.workspaceId });
          if (inspected.workspace?.id !== body.workspaceId || !Array.isArray(inspected.events)) {
            throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The original workspace audit receipt has an invalid scope.");
          }
          const events = inspected.events.filter(event => event.requestId === body.requestId);
          if (events.some(event => event.sessionId !== body.sessionId || event.payload?.action !== "process_run")) {
            throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The original process audit does not match its session and action.");
          }
          const requested = events.filter(event => event.eventType === "operation.requested");
          const completed = events.filter(event => event.eventType === "operation.completed");
          const failed = events.filter(event => event.eventType === "operation.failed");
          if (requested.length > 1 || completed.length > 1 || failed.length > 1 || (completed.length && failed.length)) {
            throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_AMBIGUOUS", "The original process has conflicting or duplicate audit receipts.");
          }
          if (requested.length === 1 && (requested[0].payload.workspaceId !== body.workspaceId ||
              requested[0].payload.executable !== body.executable || requested[0].payload.cwd !== body.cwd ||
              JSON.stringify(requested[0].payload.args) !== JSON.stringify(body.args) || requested[0].payload.timeoutMs !== body.timeoutMs)) {
            throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The persisted command differs from the original request; it was not repeated.");
          }
          if (failed.length) throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_FAILED", "The original process has a persisted failure; see its retained workspace audit.");
          if (completed.length) {
            const terminal = completed[0];
            if (requested.length !== 1 || !/^art_[a-f0-9]{24}$/u.test(terminal.payload.outputArtifactId ?? "") ||
                !/^sha256:[a-f0-9]{64}$/u.test(terminal.payload.outputBlobHash ?? "") ||
                !/^sha256:[a-f0-9]{64}$/u.test(terminal.payload.resultDigest ?? "") ||
                !Number.isSafeInteger(terminal.payload.resultBytes) || terminal.payload.resultBytes > 1_000_000) {
              throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The completed command lacks a bounded immutable output receipt.");
            }
            const exported = await read("artifact_read", { artifactId: terminal.payload.outputArtifactId, maximumBytes: 1_000_000 });
            const bytes = Buffer.from(exported.contentBase64 ?? "", "base64");
            if (exported.artifact?.id !== terminal.payload.outputArtifactId || exported.artifact.workspaceId !== body.workspaceId ||
                exported.artifact.size !== bytes.length || bytes.length !== terminal.payload.resultBytes ||
                exported.artifact.blobHash !== terminal.payload.outputBlobHash ||
                `sha256:${sha(bytes)}` !== terminal.payload.outputBlobHash || `sha256:${sha(bytes)}` !== terminal.payload.resultDigest) {
              throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The process output bytes do not match their immutable audit digests.");
            }
            const result = JSON.parse(bytes.toString("utf8"));
            if (result.sandbox !== "gVisor" || typeof result.stdout !== "string" || result.exitCode !== terminal.payload.exitCode) {
              throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_INVALID", "The immutable output does not prove the original gVisor execution.");
            }
            operation.recovery = { ...operation.recovery, status: "recovered-from-immutable-audit", requestSequence: requested[0].sequence,
              completedSequence: terminal.sequence, outputArtifactId: exported.artifact.id, outputBlobHash: exported.artifact.blobHash };
            operation.status = "response-recovered-from-read-only-audit";
            operation.exitCode = result.exitCode;
            operation.resultSha256 = sha(JSON.stringify(result));
            await save();
            return result;
          }
          await delay(Math.min(1000, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal });
        }
        throw fail("SWE_GIT_SETUP_PROCESS_RECOVERY_TIMEOUT", "The original process did not yield a persisted terminal receipt within its bounded deadline.");
      } catch (recoveryError) {
        operation.recovery.status = "stopped-without-resubmission";
        operation.recovery.failureCode = String(recoveryError.code ?? recoveryError.name);
        await save();
        throw recoveryError;
      }
    }
    throw error;
  }
};
const sameFields = (actual, expectedFields) => actual && typeof actual === "object" && !Array.isArray(actual) &&
  Object.keys(actual).length === Object.keys(expectedFields).length &&
  Object.entries(expectedFields).every(([key, value]) => actual[key] === value);
const matchingBuiltWorkspace = (workspace, planned, requireReady = false) =>
  workspace?.kind === "workspace" && /^wsp_[a-f0-9]{24}$/u.test(workspace.id ?? "") && workspace.title === planned.title &&
  sameFields(workspace.source, planned.source) && workspace.runtime?.image?.kind === "dockerfile" &&
  workspace.runtime.image.path === planned.runtime.image.path && workspace.runtime.image.context === planned.runtime.image.context &&
  sameFields(workspace.runtime.environment, planned.runtime.environment) && Array.isArray(workspace.runtime.secretRefs) &&
  workspace.runtime.secretRefs.length === 0 && workspace.runtime.network === planned.runtime.network &&
  sameFields(workspace.runtime.limits, planned.runtime.limits) &&
  (!workspace.runtime.image.imageDigest || /^sha256:[a-f0-9]{64}$/u.test(workspace.runtime.image.imageDigest)) &&
  (!requireReady || (workspace.state === "ready" && /^sha256:[a-f0-9]{64}$/u.test(workspace.runtime.image.imageDigest ?? "")));
const createBuiltWorkspace = async (item, control, planned) => {
  const began = performance.now();
  const deadline = began + 600_000;
  item.workspaceCreatePlan = { ...planned, observedAt: new Date().toISOString(), recoveryDeadlineMs: 600_000 };
  await save();
  try {
    return await control("workspace_create", planned, 650_000);
  } catch (error) {
    controller.signal.throwIfAborted();
    const httpStatus = error.publicFailure?.status;
    if (httpStatus >= 400 && httpStatus < 500) throw error;
    const timeout = error.name === "TimeoutError" ||
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(error.code ?? error.cause?.code);
    if (error.publicFailure?.code !== "CLOUD_REQUEST_UNCERTAIN" && !(timeout && httpStatus === undefined)) throw error;
    item.workspaceCreateRecovery = { status: "read-only-pending", originalCode: String(error.code ?? error.name),
      originalRequestId: item.operations.at(-1)?.requestId, mutatingResubmissions: 0, startedAt: new Date().toISOString() };
    await save();
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const read = async (action, input = {}) => {
      controller.signal.throwIfAborted();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 100) throw fail("SWE_RUNTIME_RECOVERY_TIMEOUT", "The original workspace creation did not become ready within its bounded recovery deadline.");
      return control(action, input, Math.min(20_000, remaining));
    };
    // Creation and attachment precede the long build. Permit only a short wait
    // for admission visibility, never a second create POST.
    const attachmentDeadline = Math.min(deadline, performance.now() + 15_000);
    let attached;
    while (performance.now() < attachmentDeadline) {
      const listed = await read("resource_list");
      if (!Array.isArray(listed.attached)) throw fail("SWE_RUNTIME_RECOVERY_INVALID", "The same-session attached resource receipt is invalid.");
      const matches = listed.attached.filter(resource => resource.kind === "workspace" && resource.title === planned.title);
      if (matches.length > 1) throw fail("SWE_RUNTIME_RECOVERY_AMBIGUOUS", "More than one attached workspace has the unique planned title; creation was not resubmitted.");
      if (matches.length === 1) { attached = matches[0]; break; }
      await delay(Math.min(1000, Math.max(1, attachmentDeadline - performance.now())), undefined, { signal: controller.signal });
    }
    if (!attached || !/^wsp_[a-f0-9]{24}$/u.test(attached.id ?? "")) {
      throw fail("SWE_RUNTIME_RECOVERY_NOT_ATTACHED", "The original workspace cannot be uniquely identified in its newly created session; creation was not resubmitted.");
    }
    item.workspaceId = attached.id;
    item.workspaceCreateRecovery.workspaceId = attached.id;
    while (performance.now() < deadline) {
      const inspected = await read("workspace_inspect", { workspaceId: attached.id });
      const workspace = inspected.workspace;
      if (workspace?.id !== attached.id || !matchingBuiltWorkspace(workspace, planned)) {
        throw fail("SWE_RUNTIME_RECOVERY_SCOPE_MISMATCH", "The attached workspace source or exact runtime differs from the original creation plan.");
      }
      item.workspaceCreateRecovery.lastState = workspace.state;
      item.workspaceCreateRecovery.lastObservedAt = new Date().toISOString();
      await save();
      if (workspace.state === "failed") throw fail("SWE_RUNTIME_RECOVERY_BUILD_FAILED", "The original isolated workspace build failed; see retained workspace inspection receipts.");
      if (workspace.state === "ready") {
        const snapshots = Array.isArray(inspected.snapshots)
          ? inspected.snapshots.filter(snapshot => snapshot.id === workspace.activeSnapshotId && snapshot.workspaceId === attached.id) : [];
        if (!matchingBuiltWorkspace(workspace, planned, true) || snapshots?.length !== 1 ||
            !/^snp_[a-f0-9]{24}$/u.test(snapshots[0].id ?? "") || !Array.isArray(snapshots[0].entries)) {
          throw fail("SWE_RUNTIME_RECOVERY_RECEIPT_INVALID", "The recovered workspace lacks its compiled OCI digest or unique active snapshot receipt.");
        }
        item.workspaceCreateRecovery.status = "ready-from-read-only-receipts";
        item.workspaceCreateRecovery.durationMs = Math.round(performance.now() - began);
        item.recoveredWorkspaceCreate = true;
        await save();
        return { workspace, snapshot: snapshots[0] };
      }
      if (workspace.state !== "creating") throw fail("SWE_RUNTIME_RECOVERY_STATE_INVALID", "The original workspace has an unexpected lifecycle state.");
      await delay(Math.min(3000, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal });
    }
    throw fail("SWE_RUNTIME_RECOVERY_TIMEOUT", "The original workspace creation did not become ready within its bounded recovery deadline.");
  }
};
try {
  await save();
  console.log(JSON.stringify({ ready: true, input: "hidden-credential-json", shape: '{"user_name":"...","password":"..."}', output }));
  const credentials = await readHiddenCredentials({ signal: controller.signal });
  report.account = await client.login(credentials);
  credentials.password = "";
  const call = async (path, body, options = {}) => {
    if (body !== undefined) return (await client.request(path, body, options)).result;
    return (await requestCloudObservation(client, path, { ...options,
      signal: options.signal === null ? null : options.signal ?? controller.signal,
      deadline: options.deadline ?? observationDeadline ?? inferenceDeadline,
      onRecovery: async receipt => {
        (report.observationRecovery ??= []).push({ path, runId: currentRun ?? null, ...receipt });
        await save();
      },
    })).result;
  };
  const runtime = async () => {
    const observed = await call("/runtime");
    if (observed?.build?.revision !== expected) throw Object.assign(new Error("Running revision changed; remaining inference stopped."), { code: "SWE_RUNTIME_REVISION_MISMATCH" });
    return observed;
  };
  report.runtime = await runtime();
  if (report.runtime?.build?.revision !== expected) throw new Error("Runtime revision differs from the exact deployed revision requested.");
  const runtimeText = JSON.stringify(sanitizeEvidence(report.runtime), null, 2) + "\n";
  await writeFile(join(output, "cloud-runtime.json"), runtimeText, { mode: 0o600 });
  report.runtimeEvidence = { file: join(output, "cloud-runtime.json"), sha256: sha(runtimeText), source: "ordinary-cloud-runtime-API" };
  stage = "ordinary-runtime-seed";
  const seedOutput = join(output, "runtime-seed");
  await mkdir(seedOutput, { mode: 0o700 });
  const seed = report.runtimeSeed = { status: "initializing", operations: [],
    dockerfilePath: `__harness_swe_runtime_${randomUUID().replaceAll("-", "")}.Dockerfile`, dockerfileSha256: dockerfileDigest,
    dockerignoreSha256: sha(dockerignore) };
  const seedSession = (await call("/sessions", { title: "SWE Python/Git runtime seed" })).session;
  seed.sessionId = seedSession.id;
  const seedSessionText = JSON.stringify(sanitizeEvidence(seedSession), null, 2) + "\n";
  const seedSessionFile = join(seedOutput, "cloud-session.json");
  await writeFile(seedSessionFile, seedSessionText, { flag: "wx", mode: 0o600 });
  seed.sessionEvidence = { file: seedSessionFile, sha256: sha(seedSessionText), source: "ordinary-cloud-sessions-API" };
  const seedControl = makeControl(seed, seedOutput);
  const seedCreated = await seedControl("workspace_create", { title: "SWE runtime Dockerfile seed", source: { kind: "empty" }, runtimeId: "python313" });
  seed.workspaceId = seedCreated.workspace?.id;
  if (!/^wsp_[a-f0-9]{24}$/u.test(seed.workspaceId ?? "") || seedCreated.workspace.state !== "ready") {
    throw Object.assign(new Error("The ordinary runtime seed workspace is not ready; no inference started."), { code: "SWE_RUNTIME_SEED_INVALID" });
  }
  seed.runtime = seedCreated.workspace.runtime;
  await seedControl("file_write", { path: seed.dockerfilePath, content: dockerfile });
  await seedControl("file_write", { path: ".dockerignore", content: dockerignore });
  // This independently authored public fixture contains no secrets. Preserve its
  // readable mode through the snapshot so the isolated builder can read it.
  const readable = await seedControl("process_run", { executable: "python", args: ["-c",
    "import pathlib,sys; paths=[pathlib.Path(p) for p in sys.argv[1:]]; [(p.chmod(0o644), print(oct(p.stat().st_mode & 0o777))) for p in paths]",
    seed.dockerfilePath, ".dockerignore"],
  cwd: ".", timeoutMs: 30_000 }, 45_000);
  if (readable.exitCode !== 0 || readable.sandbox !== "gVisor" || readable.stdout?.trim() !== "0o644\n0o644") {
    throw Object.assign(new Error("The public Dockerfile seed could not be made readable inside gVisor; no inference started."), { code: "SWE_RUNTIME_SEED_MODE_FAILED" });
  }
  const seedSnapshot = (await seedControl("workspace_snapshot")).snapshot;
  const seedEntry = seedSnapshot?.entries?.find(entry => entry.path === seed.dockerfilePath);
  const ignoreEntry = seedSnapshot?.entries?.find(entry => entry.path === ".dockerignore");
  if (!/^snp_[a-f0-9]{24}$/u.test(seedSnapshot?.id ?? "") || seedSnapshot.workspaceId !== seed.workspaceId ||
      seedSnapshot.entries.length !== 2 || seedEntry?.kind !== "file" || seedEntry.mode !== 0o644 ||
      seedEntry.size !== Buffer.byteLength(dockerfile) || seedEntry.blobHash !== `sha256:${dockerfileDigest}` ||
      ignoreEntry?.kind !== "file" || ignoreEntry.mode !== 0o644 || ignoreEntry.size !== Buffer.byteLength(dockerignore) ||
      ignoreEntry.blobHash !== `sha256:${sha(dockerignore)}`) {
    throw Object.assign(new Error("The actual runtime seed snapshot does not match the exact reviewed Dockerfile."), { code: "SWE_RUNTIME_SEED_SNAPSHOT_INVALID" });
  }
  seed.snapshot = seedSnapshot;
  seed.status = "snapshot-ready";
  await save();
  report.status = "actual-cloud-inference";
  for (const task of manifest.tasks.filter(task => selectedIds.includes(task.instance_id))) {
    controller.signal.throwIfAborted();
    const item = { instance_id: task.instance_id, inputSha256: sha(task.problem_statement), baseCommit: task.base_commit,
      modelCalls: 0, routingModelCalls: 0, sharedModelCalls: 0, status: "initializing", operations: [] };
    report.cases.push(item);
    const began = performance.now();
    const caseOutput = join(output, task.instance_id);
    await mkdir(caseOutput, { mode: 0o700 });
    const patchPath = `__harness_prediction_${randomUUID().replaceAll("-", "")}.patch`;
    item.excludedRuntimePaths = [".harness/", ".harness-restore-*/", "lost+found/", patchPath];
    const sourcePaths = [".", ":(top,exclude).harness", ":(top,exclude,glob).harness-restore-*",
      ":(top,exclude,glob).harness-restore-*/**", ":(top,exclude)lost+found", `:(top,exclude,literal)${patchPath}`];
    async function settleAcceptedRun() {
      const deadline = performance.now() + 30_000;
      const cleanupCall = async (path, body) => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 100) throw new Error("Bounded cancellation/evidence deadline reached.");
        return call(path, body, { signal: null, timeoutMs: Math.min(5000, remaining), deadline });
      };
      item.terminalConfirmed = false;
      try {
        const observeRun = async () => {
          const run = (await cleanupCall(`/runs/${item.runId}`)).run;
          if (run?.id !== item.runId || run.sessionId !== item.sessionId) throw new Error("Cancellation receipt scope mismatch.");
          if (!["running", "queued", "completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
            throw new Error("Cancellation receipt has an unknown run state.");
          }
          item.terminalConfirmed = ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
          return run;
        };
        let run = await observeRun();
        if (!item.terminalConfirmed) {
          item.cancellationAttempted = true;
          await save();
          try {
            await cleanupCall(`/runs/${item.runId}/cancel`, {});
            item.cancellationRequested = true;
          } catch (cancelError) {
            item.cancellationFailure = { code: String(cancelError.code ?? cancelError.name), name: cancelError.name,
              ...(cancelError.publicFailure ? { publicFailure: cancelError.publicFailure } : {}) };
            await save();
            if ([401, 402, 403].includes(cancelError.publicFailure?.status)) throw cancelError;
          }
        }
        while (!item.terminalConfirmed && performance.now() < deadline - 5000) {
          // A lost cancellation response is not permission to replay its POST.
          run = await observeRun();
          if (item.terminalConfirmed) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (item.terminalConfirmed) {
          item.runStatus = run.status;
          const text = JSON.stringify(sanitizeEvidence(run), null, 2) + "\n";
          await writeFile(join(caseOutput, "cloud-run.json"), text, { mode: 0o600 });
          item.runEvidence = { file: join(caseOutput, "cloud-run.json"), sha256: sha(text), source: "ordinary-cloud-runs-API" };
        }
        // Final receipt capture intentionally skips budget/infrastructure rejection:
        // those failures are the evidence to retain, and cannot block cancellation proof.
        const events = [];
        let cursor = 0;
        for (let page = 0; page < 256; page += 1) {
          const value = await cleanupCall(`/sessions/${item.sessionId}/events?after=${cursor}`);
          if (!Array.isArray(value.events)) throw new Error("Final cloud event page invalid.");
          for (const event of value.events) {
            if (event.sessionId !== item.sessionId || event.eventSeq !== cursor + 1) throw new Error("Final cloud event cursor invalid.");
            events.push(event); cursor = event.eventSeq;
          }
          if (value.nextEventSeq !== cursor || (value.hasMore && !value.events.length)) throw new Error("Final cloud event page failed to advance.");
          if (!value.hasMore) break;
          if (page === 255) throw new Error("Final cloud event page limit exceeded.");
        }
        const ownEvents = events.filter(event => event.turnId === item.runId);
        const eventText = JSON.stringify(sanitizeEvidence(ownEvents), null, 2) + "\n";
        await writeFile(join(caseOutput, "cloud-events.json"), eventText, { mode: 0o600 });
        item.persisted = { source: "ordinary-cloud-session-events-API", events: ownEvents.length,
          file: join(caseOutput, "cloud-events.json"), sha256: sha(eventText), lastEventSeq: cursor };
        accountModelAttempts(item, ownEvents);
        item.finalEvidenceCollected = true;
      } catch (cleanupError) {
        item.cleanupFailure = { code: String(cleanupError.code ?? cleanupError.name),
          message: "Cancellation or final cloud receipt could not be confirmed within the bounded cleanup window.",
          ...(cleanupError.publicFailure ? { publicFailure: cleanupError.publicFailure } : {}),
          ...(cleanupError.observationRecovery ? { observationRecovery: cleanupError.observationRecovery } : {}) };
      }
      item.lifecycleIncomplete = !item.terminalConfirmed || !item.finalEvidenceCollected;
      if (item.lifecycleIncomplete) report.lifecycleIncomplete = true;
    }
    try {
      stage = "ordinary-session-and-workspace";
      const session = (await call("/sessions", { title: `SWE-bench Verified ${task.instance_id}` })).session;
      item.sessionId = session.id;
      const sessionText = JSON.stringify(sanitizeEvidence(session), null, 2) + "\n";
      await writeFile(join(caseOutput, "cloud-session.json"), sessionText, { mode: 0o600 });
      item.sessionEvidence = { file: join(caseOutput, "cloud-session.json"), sha256: sha(sessionText), source: "ordinary-cloud-sessions-API" };
      const control = makeControl(item, caseOutput);
      stage = "ordinary-isolated-runtime-build";
      item.runtimeSeed = { workspaceId: seed.workspaceId, snapshotId: seedSnapshot.id, snapshotDigest: seedSnapshot.digest,
        dockerfilePath: seed.dockerfilePath, dockerfileSha256: dockerfileDigest, dockerignoreSha256: sha(dockerignore) };
      const requestedRuntime = { image: { kind: "dockerfile", path: seed.dockerfilePath, context: "." },
        environment: {}, secretRefs: [], network: "public", limits: { cpu: 1, memoryMiB: 1536, pids: 256,
          diskMiB: 4096, timeoutSeconds: 600, maxOutputBytes: 1_000_000 } };
      const planned = { title: `SWE ${task.instance_id} ${randomUUID()}`,
        source: { kind: "snapshot", snapshotId: seedSnapshot.id }, runtime: requestedRuntime };
      const created = await createBuiltWorkspace(item, control, planned);
      item.workspaceId = created.workspace?.id;
      item.runtime = created.workspace?.runtime;
      item.initialSnapshot = created.snapshot;
      if (!matchingBuiltWorkspace(created.workspace, planned, true)) {
        throw Object.assign(new Error("The actual isolated builder did not return a ready workspace with a compiled OCI image digest."), { code: "SWE_RUNTIME_BUILD_RECEIPT_INVALID" });
      }
      const sandboxProcess = async (executable, commandArgs, timeoutMs = 120_000) => {
        const result = await control("process_run", { executable, args: commandArgs, cwd: ".", timeoutMs }, timeoutMs + 15_000);
        if (result.exitCode !== 0 || result.sandbox !== "gVisor" || typeof result.stdout !== "string") {
          throw Object.assign(new Error(`Actual cloud ${executable} command did not exit successfully inside gVisor; see the immutable operation response.`), { code: "SWE_GIT_SETUP_OR_EXPORT_FAILED" });
        }
        return result;
      };
      const process = (commandArgs, timeoutMs) => sandboxProcess("git", commandArgs, timeoutMs);
      stage = "workspace-toolchain-preflight";
      item.preflight = { python: await sandboxProcess("python", ["--version"], 30_000) };
      item.preflight.git = await process(["--version"], 30_000);
      item.preflight.ripgrep = await sandboxProcess("rg", ["--version"], 30_000);
      if (!/^Python 3\./u.test(`${item.preflight.python.stdout}\n${item.preflight.python.stderr ?? ""}`.trim()) ||
          !/^git version [0-9]/u.test(item.preflight.git.stdout.trim()) ||
          !/^ripgrep [0-9]/u.test(item.preflight.ripgrep.stdout.trim())) {
        throw Object.assign(new Error("Actual Python/Git/ripgrep version preflight did not identify the required tools; inference was not started."), { code: "SWE_GIT_SETUP_PREFLIGHT_FAILED" });
      }
      await control("file_remove", { path: seed.dockerfilePath });
      await control("file_remove", { path: ".dockerignore" });
      stage = "exact-base-source-upload";
      await uploadPreparedSource({ item, source: preparedSources.get(task.instance_id), control, sandboxProcess, save });
      const actualBase = (await process(["rev-parse", "HEAD"])).stdout.trim();
      const actualTree = (await process(["rev-parse", "HEAD^{tree}"])).stdout.trim();
      const shallow = (await process(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
      const rootTree = (await process(["ls-tree", "-z", "--name-only", task.base_commit])).stdout;
      if (rootTree.split("\0").some(name => name === ".harness" || name === "lost+found" || name.startsWith(".harness-restore-") || name === patchPath)) {
        throw Object.assign(new Error("Reserved runtime paths are tracked by the benchmark base; exclusions cannot hide legitimate source."), { code: "SWE_GIT_SETUP_RESERVED_PATH_CONFLICT" });
      }
      const clean = (await process(["status", "--porcelain", "--", ...sourcePaths])).stdout.trim() === "";
      item.source = { repo: task.repo, commit: actualBase, tree: actualTree, cleanBeforeInference: clean, shallowExactBase: shallow,
        materialization: "local exact-base archive uploaded through ordinary cloud file/process capabilities",
        cleanScope: "source tree excluding verified-untracked reserved runtime paths", baseRootTreeSha256: sha(rootTree), reservedRuntimePathsTrackedAtBase: false };
      if (actualBase !== task.base_commit || actualTree !== preparedSources.get(task.instance_id).tree || !shallow || !clean) {
        throw new Error("Actual uploaded cloud checkout is not the clean, shallow exact benchmark base and tree.");
      }
      stage = "actual-model-inference";
      await runtime();
      if (report.sharedModelCalls + 12 > report.limits.totalModelCalls) throw Object.assign(new Error("Insufficient shared budget for an ordinary 12-call run."), { code: "SWE_BUDGET_ADMISSION_DENIED" });
      item.input = `Work only in attached workspace ${item.workspaceId}, a Python repository at the exact issue base commit.\n` +
        "Fix the following issue by inspecting and changing actual source files. You may install needed dependencies and execute focused real repository tests through the workspace tools. " +
        "Do not delegate, start workflows, push, deploy, access business resources, fetch later source revisions, search for benchmark/reference patches, or request hints. " +
        "Do not edit reserved runtime paths .harness, .harness-restore-* or lost+found. Do not rewrite Git history or change the Git index yourself; the harness will export a base-relative patch. Avoid committing. Finish within the remaining bounded model-call budget.\n\nISSUE:\n" + task.problem_statement;
      if (item.input.length > 10_000) throw new Error("Issue prompt exceeds the ordinary cloud run API limit.");
      const requestId = randomUUID();
      item.requestId = requestId;
      const accepted = await call(`/sessions/${item.sessionId}/runs`, { requestId, message: item.input });
      currentRun = item.runId = accepted.run.id;
      let run = accepted.run;
      const allEvents = [];
      let cursor = 0;
      async function collect() {
        for (let page = 0; page < 256; page += 1) {
          const value = await call(`/sessions/${item.sessionId}/events?after=${cursor}`);
          if (!Array.isArray(value.events) || typeof value.hasMore !== "boolean" || !Number.isSafeInteger(value.nextEventSeq)) throw new Error("Cloud event page protocol mismatch.");
          for (const event of value.events) {
            if (event.sessionId !== item.sessionId || event.eventSeq !== cursor + 1) throw new Error("Cloud transcript sequence mismatch.");
            allEvents.push(event); cursor = event.eventSeq;
          }
          if (value.nextEventSeq !== cursor || (value.hasMore && !value.events.length)) throw new Error("Cloud transcript cursor did not advance.");
          accountModelAttempts(item, allEvents.filter(event => event.turnId === item.runId));
          const text = JSON.stringify(sanitizeEvidence(allEvents.filter(event => event.turnId === item.runId)), null, 2) + "\n";
          await writeFile(join(caseOutput, "cloud-events.json"), text, { mode: 0o600 });
          item.persisted = { source: "ordinary-cloud-session-events-API", events: allEvents.filter(event => event.turnId === item.runId).length,
            file: join(caseOutput, "cloud-events.json"), sha256: sha(text), lastEventSeq: cursor };
          if (item.sharedModelCalls > 12 || report.sharedModelCalls > report.limits.totalModelCalls) throw Object.assign(new Error("Actual persisted shared model calls exceeded the budget."), { code: "SWE_BUDGET_EXCEEDED" });
          if (allEvents.some(event => event.type === "model.responded" && ["MODEL_AUTH_REQUIRED", "MODEL_ACCESS_DENIED", "MODEL_QUOTA_EXHAUSTED"].includes(event.payload.failureCode))) {
            throw Object.assign(new Error("Actual model authorization or quota failed; inference stopped."), { code: "SWE_MODEL_ACCESS_BLOCKED" });
          }
          const blocked = allEvents.find(event => event.type === "tool.failed" && infrastructureFailure(event.payload.code));
          if (blocked) throw Object.assign(new Error("Actual cloud infrastructure failed; remaining cases stopped."), { code: blocked.payload.code });
          if (allEvents.some(event => event.type === "tool.started" && /^(?:delegate_|workflow_)/u.test(event.payload.toolName))) {
            throw Object.assign(new Error("Unexpected delegation; bounded single-run benchmark inference stopped."), { code: "SWE_UNEXPECTED_DELEGATION" });
          }
          if (!value.hasMore) return;
          if (page === 255) throw new Error("Cloud transcript page limit exceeded.");
        }
      }
      const caseDeadline = performance.now() + report.limits.perCaseMs;
      observationDeadline = caseDeadline;
      while (["running", "queued"].includes(run.status) && performance.now() < caseDeadline) {
        controller.signal.throwIfAborted();
        await collect();
        await new Promise(resolve => setTimeout(resolve, 1000));
        run = (await call(`/runs/${item.runId}`)).run;
      }
      if (["running", "queued"].includes(run.status)) {
        throw Object.assign(new Error("Case deadline reached; cancellation will be requested; accepted run was not resubmitted."), { code: "SWE_CASE_TIMEOUT" });
      }
      currentRun = undefined;
      observationDeadline = undefined;
      item.terminalConfirmed = true;
      await collect();
      await runtime();
      item.runStatus = run.status;
      const runText = JSON.stringify(sanitizeEvidence(run), null, 2) + "\n";
      await writeFile(join(caseOutput, "cloud-run.json"), runText, { mode: 0o600 });
      item.runEvidence = { file: join(caseOutput, "cloud-run.json"), sha256: sha(runText), source: "ordinary-cloud-runs-API" };
      const events = allEvents.filter(event => event.turnId === item.runId);
      const safeEvents = sanitizeEvidence(events);
      const eventsText = JSON.stringify(safeEvents, null, 2) + "\n";
      const eventFile = join(caseOutput, "cloud-events.json");
      await writeFile(eventFile, eventsText, { mode: 0o600 });
      item.persisted = { source: "ordinary-cloud-session-events-API", events: events.length,
        file: eventFile, sha256: sha(eventsText), lastEventSeq: cursor };
      accountModelAttempts(item, events);
      item.successfulModelResponses = events.filter(event => event.type === "model.responded" && event.payload.status === "completed").length;
      item.diagnostics = await call(`/runs/${item.runId}/diagnostics`);
      if (events.some(event => event.type === "model.responded" && ["MODEL_AUTH_REQUIRED", "MODEL_ACCESS_DENIED", "MODEL_QUOTA_EXHAUSTED"].includes(event.payload.failureCode))) {
        throw Object.assign(new Error("Actual model authorization or quota failed; remaining cases stopped."), { code: "SWE_MODEL_ACCESS_BLOCKED" });
      }
      stage = "actual-base-relative-patch-export";
      await process(["add", "-N", "--", ...sourcePaths]);
      await process(["diff", "--binary", "--no-ext-diff", "--no-textconv", `--output=${patchPath}`, task.base_commit, "--", ...sourcePaths]);
      const artifact = (await control("artifact_create", { path: patchPath, title: `SWE patch ${task.instance_id}`,
        mediaType: "text/x-diff", sourceRun: item.runId, metadata: { instanceId: task.instance_id, baseCommit: task.base_commit, runId: item.runId } })).artifact;
      if (!Number.isSafeInteger(artifact.size) || artifact.size > 1_000_000) throw new Error("Actual patch exceeds the bounded artifact export limit; no truncated prediction submitted.");
      const exported = await control("artifact_read", { artifactId: artifact.id, maximumBytes: 1_000_000 });
      const artifactBytes = Buffer.from(exported.contentBase64, "base64");
      if (exported.artifact.id !== artifact.id || exported.artifact.workspaceId !== item.workspaceId ||
          exported.artifact.size !== artifactBytes.length || artifact.size !== artifactBytes.length ||
          exported.artifact.blobHash !== artifact.blobHash || artifact.blobHash !== `sha256:${sha(artifactBytes)}`) {
        throw new Error("Immutable cloud patch artifact bytes and metadata do not match.");
      }
      const patch = artifactBytes.toString("utf8");
      if (!Buffer.from(patch, "utf8").equals(artifactBytes)) throw new Error("Actual patch is not valid UTF-8; no lossy prediction export permitted.");
      const patchFile = join(caseOutput, "prediction.patch");
      await writeFile(patchFile, artifactBytes, { mode: 0o600 });
      item.patch = { file: patchFile, sha256: sha(patch), bytes: artifactBytes.length, artifactId: artifact.id,
        artifactBlobHash: artifact.blobHash, baseRelative: true };
      item.status = patch.trim() ? "actual-patch-exported" : "actual-empty-patch-exported";
      if (item.modelCalls > 0 && item.successfulModelResponses > 0) predictions.push({ instance_id: task.instance_id,
        model_name_or_path: `daoyin-cloud-${expected.slice(0, 12)}`, model_patch: patch });
      else item.status = "no-successful-model-inference";
      if (["interrupted", "cancelled"].includes(run.status)) {
        throw Object.assign(new Error("The accepted run was interrupted or cancelled; retained its terminal evidence and patch and stopped remaining case admission."),
          { code: "SWE_RUNTIME_INTERRUPTED" });
      }
    } catch (error) {
      item.status = "blocked-or-incomplete";
      if (item.workspaceCreateRecovery?.status === "read-only-pending") {
        item.workspaceCreateRecovery.status = "stopped-without-resubmission";
        item.workspaceCreateRecovery.failureCode = String(error.code ?? error.name);
      }
      item.error = { code: String(error.code ?? error.name), stage, message: String(error.message).slice(0, 700),
        ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}),
        ...(error.observationRecovery ? { observationRecovery: error.observationRecovery } : {}) };
      if (!currentRun && item.requestId && !item.runId) {
        // A timed-out POST may have been accepted. Read its receipt once; never resubmit it.
        try {
          const receipt = await call(`/sessions/${item.sessionId}/runs`, undefined, { signal: null, timeoutMs: 15_000, totalTimeoutMs: 15_000,
            deadline: performance.now() + 15_000 });
          const accepted = receipt.runs?.find(run => run.requestId === item.requestId);
          if (accepted) { item.runId = accepted.id; item.recoveredAcceptedReceipt = true; currentRun = accepted.id; }
          else { item.lifecycleIncomplete = true; report.lifecycleIncomplete = true; }
        } catch { item.receiptRecoveryUnavailable = true; item.lifecycleIncomplete = true; report.lifecycleIncomplete = true; }
      }
      if (currentRun) {
        await settleAcceptedRun();
        currentRun = undefined;
      }
      if ([401, 402, 403].includes(error.publicFailure?.status) || ["SWE_MODEL_ACCESS_BLOCKED", "SWE_RUNTIME_INTERRUPTED"].includes(error.code) ||
          stage === "ordinary-isolated-runtime-build" || infrastructureFailure(error.code ?? error.publicFailure?.code) ||
          item.lifecycleIncomplete || controller.signal.aborted) throw error;
    } finally { observationDeadline = undefined; item.durationMs = Math.round(performance.now() - began); await save(); }
  }
  report.status = predictions.length === selectedIds.length ? "cloud-inference-exported-awaiting-official-grading" : "cloud-inference-incomplete";
} catch (error) {
  report.status = controller.signal.aborted ? "cancelled-or-timeout" : "blocked";
  report.error = { code: String(error.code ?? error.name), stage, message: String(error.message).slice(0, 700),
    ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}),
    ...(error.observationRecovery ? { observationRecovery: error.observationRecovery } : {}) };
} finally {
  clearTimeout(timer); client.close(); report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - started); report.submittedIds = predictions.map(row => row.instance_id);
  report.missingIds = selectedIds.filter(id => !report.submittedIds.includes(id)); await save();
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
console.log(JSON.stringify({ status: report.status, output, submitted: predictions.length, modelCalls: report.modelCalls }));
process.exitCode = predictions.length === selectedIds.length ? 0 : 1;
