// Grade only patches exported by an actual Harness inference run.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = await realpath(resolve(import.meta.dirname, ".."));
const hash = value => createHash("sha256").update(value).digest("hex");
const ids = ["pytest-dev__pytest-5787", "pytest-dev__pytest-5631", "sympy__sympy-12481"];
async function cachePath(path) {
  const actual = await realpath(resolve(root, path));
  const rel = relative(join(root, ".cache"), actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Evidence must stay inside repository .cache.");
  return actual;
}

export async function gradeSwebench({ inferenceReport, signal } = {}) {
  signal?.throwIfAborted();
  if (!inferenceReport) throw new Error("Provide an actual inference report.");
  const source = await cachePath(inferenceReport);
  const sourceText = await readFile(source, "utf8");
  const inference = JSON.parse(sourceText);
  if (inference.kind !== "swebench-verified-cloud-harness-inference" || inference.mode !== "real" ||
      inference.fakeModels !== false || inference.fabricatedBusinessResponses !== false ||
      !(inference.modelCalls > 0) || inference.modelCalls > 36 || inference.lifecycleIncomplete === true ||
      inference.datasetRevision !== "c104f840cc67f8b6eec6f759ebc8b2693d585d4a") {
    throw new Error("Official grading requires real Harness inference at the pinned dataset revision.");
  }
  if (!Array.isArray(inference.cases) || inference.cases.some(item => !Number.isSafeInteger(item.modelCalls) || item.modelCalls < 0 || item.modelCalls > 12) ||
      inference.cases.reduce((sum, item) => sum + item.modelCalls, 0) !== inference.modelCalls) {
    throw new Error("Cloud inference model accounting does not match the bounded actual case exports.");
  }
  const runtimeText = await readFile(await cachePath(inference.runtimeEvidence?.file ?? ""), "utf8");
  if (inference.runtimeEvidence?.source !== "ordinary-cloud-runtime-API" || hash(runtimeText) !== inference.runtimeEvidence.sha256 ||
      JSON.parse(runtimeText).build?.revision !== inference.expectedRuntimeRevision) throw new Error("Actual cloud runtime evidence changed.");
  const manifestPath = await cachePath(".cache/swebench-verified-3/manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  if (hash(manifestText) !== inference.manifestSha256 || manifest.datasetRevision !== inference.datasetRevision ||
      manifest.dataset !== "princeton-nlp/SWE-bench_Verified") throw new Error("Inference manifest provenance mismatch.");
  const datasetPath = await cachePath(manifest.datasetPath);
  if (hash(await readFile(datasetPath)) !== manifest.datasetSha256) throw new Error("Pinned dataset checksum changed.");
  const inferenceOutput = await cachePath(inference.output);
  const predictionsPath = await cachePath(join(inferenceOutput, "predictions.jsonl"));
  const predictionsText = await readFile(predictionsPath, "utf8");
  const predictions = predictionsText.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
  const seen = new Set();
  for (const item of predictions) {
    if (!ids.includes(item.instance_id) || seen.has(item.instance_id) || typeof item.model_patch !== "string" ||
        Buffer.byteLength(item.model_patch) > 1_000_000 ||
        item.model_name_or_path !== `daoyin-cloud-${inference.expectedRuntimeRevision?.slice(0, 12)}`) throw new Error("Invalid actual prediction export.");
    seen.add(item.instance_id);
    const observation = inference.cases?.find(value => value.instance_id === item.instance_id);
    const task = manifest.tasks.find(value => value.instance_id === item.instance_id);
    if (!observation?.patch || !(observation.modelCalls > 0) || observation.modelCalls > 12 || !(observation.successfulModelResponses > 0) ||
        observation.persisted?.source !== "ordinary-cloud-session-events-API" ||
        observation.source?.cleanBeforeInference !== true || observation.source.commit !== task?.base_commit ||
        observation.patch.sha256 !== hash(item.model_patch) || observation.patch.artifactBlobHash !== `sha256:${hash(item.model_patch)}` ||
        observation.patch.baseRelative !== true || !/^art_[a-f0-9]{24}$/u.test(observation.patch.artifactId ?? "") ||
        typeof observation.sessionId !== "string" || typeof observation.runId !== "string" ||
        inference.runtime?.build?.revision !== inference.expectedRuntimeRevision ||
        !/^[a-f0-9]{40}$/u.test(inference.expectedRuntimeRevision ?? "")) {
      throw new Error("Prediction has no matching actual cloud inference, exact source or immutable artifact evidence.");
    }
    const patch = await readFile(await cachePath(observation.patch.file), "utf8");
    if (patch !== item.model_patch || observation.inputSha256 !== hash(task.problem_statement)) {
      throw new Error("Actual exported patch or issue identity changed.");
    }
    const eventText = await readFile(await cachePath(observation.persisted.file), "utf8");
    for (const [key, expectedSource, identifier] of [["sessionEvidence", "ordinary-cloud-sessions-API", observation.sessionId],
      ["runEvidence", "ordinary-cloud-runs-API", observation.runId]]) {
      const receipt = observation[key];
      const text = await readFile(await cachePath(receipt?.file ?? ""), "utf8");
      if (receipt?.source !== expectedSource || hash(text) !== receipt.sha256 || JSON.parse(text).id !== identifier) {
        throw new Error("Actual ordinary cloud session/run receipt changed.");
      }
    }
    if (hash(eventText) !== observation.persisted.sha256) throw new Error("Cloud event export checksum changed.");
    const events = JSON.parse(eventText);
    if (!Array.isArray(events) || events.length !== observation.persisted.events ||
        events.some((event, index) => event.sessionId !== observation.sessionId || event.turnId !== observation.runId ||
          !Number.isSafeInteger(event.eventSeq) || (index > 0 && event.eventSeq <= events[index - 1].eventSeq)) ||
        !events.some(event => event.type === "turn.started" && event.payload.userMessage.includes(task.problem_statement)) ||
        !events.some(event => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type))) {
      throw new Error("Actual ordinary cloud transcript identity or persisted terminal evidence is missing.");
    }
    const calls = new Set(events.filter(event => event.type === "model.requested").map(event => event.payload.modelCallId));
    if (calls.size !== observation.modelCalls || !events.some(event => event.type === "model.responded" &&
        event.payload.status === "completed" && calls.has(event.payload.modelCallId))) {
      throw new Error("Cloud model audit does not prove actual successful model inference.");
    }
    const starts = new Set(events.filter(event => event.type === "tool.started").map(event => event.payload.toolCallId));
    if (events.some(event => event.type === "tool.started" && /^(?:delegate_|workflow_)/u.test(event.payload.toolName))) {
      throw new Error("Unexpected delegated work has no bounded single-run benchmark acceptance.");
    }
    if (events.some(event => event.type === "tool.completed" && !starts.has(event.payload.toolCallId))) {
      throw new Error("Cloud tool completion has no matching actual started action.");
    }
  }
  if (!predictions.length) throw new Error("No actual predictions exist; do not substitute empty or gold patches.");
  const output = join(root, ".cache", "swebench-grade", new Date().toISOString().replaceAll(":", "-") + "_" + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true, mode: 0o700 });
  await cachePath(output);
  const runId = "daoyin-verified-3-" + randomUUID().slice(0, 8);
  // v3 writes the aggregate in cwd even when report_dir is supplied.
  const resultsDirectory = output;
  const report = { kind: "swebench-cloud-inference-official-grading", status: "preflight", output, runId,
    runnerSha256: hash(await readFile(import.meta.filename)),
    inferenceReport: source, inferenceReportSha256: hash(sourceText), predictionsPath, predictionsSha256: hash(predictionsText),
    datasetRevision: inference.datasetRevision, datasetSha256: manifest.datasetSha256, graderVersion: "3.0.15",
    selectedIds: ids, submittedIds: [...seen], missingInferenceIds: ids.filter(id => !seen.has(id)),
    limits: { workers: 1, perInstanceTestTimeoutSeconds: 900, totalProcessTimeoutMs: 5_400_000, capturedOutputBytes: 8_000_000 },
    environment: { platform: process.platform, arch: process.arch, execution: "independent trusted Docker daemon; not cloud gVisor inference" }, official: null, startedAt: new Date().toISOString() };
  const save = () => writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const start = performance.now();
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1",
    HF_HOME: join(output, "hf-cache"), XDG_CACHE_HOME: join(output, "cache"), TMPDIR: join(output, "tmp") };
  await mkdir(environment.TMPDIR, { mode: 0o700 });
  const python = join(root, ".cache", "swebench-grader", "bin", "python");
  await save();
  async function cleanupOwnContainers() {
    if (!report.command || !environment.DOCKER_HOST) return;
    report.containerCleanup = { removed: [], errors: [] };
    const allowedNames = [...seen].map(id => `sweb.eval.${id.toLowerCase()}.${runId}`);
    try {
      // Scope both the listing and every removal to this unique evaluation run.
      const listed = (await execute("docker", ["ps", "--all", "--filter", `name=${runId}`, "--format", "{{json .}}"],
        { cwd: output, env: environment, timeout: 15_000, maxBuffer: 100_000 })).stdout;
      for (const row of listed.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line))) {
        if (!/^[a-f0-9]{12,64}$/u.test(row.ID ?? "") || !allowedNames.some(name => row.Names === name ||
            (row.Names?.startsWith(name + ".") && /^\d+$/u.test(row.Names.slice(name.length + 1))))) continue;
        try {
          await execute("docker", ["rm", "--force", "--", row.ID], { cwd: output, env: environment, timeout: 15_000, maxBuffer: 100_000 });
          report.containerCleanup.removed.push(row.Names);
        } catch { report.containerCleanup.errors.push({ name: row.Names, stage: "remove" }); }
      }
    } catch { report.containerCleanup.errors.push({ stage: "list" }); }
  }
  try {
    signal?.throwIfAborted();
    const version = (await execute(python, ["-c", "import importlib.metadata; print(importlib.metadata.version('swebench'))"],
      { cwd: output, env: environment, timeout: 30_000, maxBuffer: 100_000, signal })).stdout.trim();
    if (version !== report.graderVersion) throw new Error("Official grader version mismatch.");
    const dockerEnvironment = { ...environment, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker") };
    const context = (await execute("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { cwd: output, env: dockerEnvironment, timeout: 30_000, maxBuffer: 100_000, signal })).stdout.trim();
    if (!context.startsWith("unix://")) throw new Error("This grader runner requires the existing local Unix Docker daemon.");
    environment.DOCKER_HOST = context;
    const daemon = JSON.parse((await execute("docker", ["info", "--format",
      '{"serverVersion":{{json .ServerVersion}},"architecture":{{json .Architecture}},"memoryBytes":{{.MemTotal}},"cpus":{{.NCPU}}}'],
    { cwd: output, env: environment, timeout: 30_000, maxBuffer: 100_000, signal })).stdout);
    if (typeof daemon.serverVersion !== "string" || typeof daemon.architecture !== "string" ||
        !Number.isSafeInteger(daemon.memoryBytes) || daemon.memoryBytes <= 0 || !Number.isSafeInteger(daemon.cpus) || daemon.cpus <= 0) {
      throw new Error("Actual Docker daemon capability metadata is unavailable.");
    }
    report.environment.daemon = daemon;
    const space = await statfs(output);
    report.freeDiskBytesBefore = space.bavail * space.bsize;
    if (report.freeDiskBytesBefore < 12 * 1024 ** 3) throw new Error("Less than 12 GiB free for the official Docker evaluation; no images started.");
    const graderDataset = join(output, "grader-only-instances.json");
    // The official legacy grader accepts JSON. Copy pinned full records only into its isolated directory;
    // neither reference patches nor test patches are returned to the Agent or inference workspaces.
    const convert = "import json, sys; import pyarrow.parquet as p; " +
      "manifest=json.load(open(sys.argv[2])); wanted={r['instance_id']:r for r in manifest['tasks']}; " +
      "rows=[r for r in p.read_table(sys.argv[1]).to_pylist() if r['instance_id'] in wanted]; " +
      "assert len(rows)==3 and all(all(r[k]==wanted[r['instance_id']][k] for k in ['base_commit','repo','problem_statement','version']) for r in rows); " +
      "json.dump(rows,open(sys.argv[3],'w'))";
    await execute(python, ["-c", convert, datasetPath, manifestPath, graderDataset],
      { cwd: output, env: environment, timeout: 30_000, maxBuffer: 100_000, signal });
    report.graderDataset = { file: graderDataset, sha256: hash(await readFile(graderDataset)), referencePatchExposedToAgent: false };
    const args = ["-m", "swebench.harness.run_evaluation", "--dataset_name", graderDataset,
      "--predictions_path", predictionsPath, "--instance_ids", ...ids, "--max_workers", "1", "--timeout", "900",
      "--run_id", runId, "--report_dir", resultsDirectory, "--namespace", "none"];
    report.command = { executable: python, args }; report.status = "official-grader-running"; await save();
    console.log(JSON.stringify({ status: report.status, output, submitted: predictions.length }));
    const result = await execute(python, args, { cwd: output, env: environment, timeout: report.limits.totalProcessTimeoutMs,
      maxBuffer: report.limits.capturedOutputBytes, signal });
    await writeFile(join(output, "stdout.log"), result.stdout, { mode: 0o600 });
    await writeFile(join(output, "stderr.log"), result.stderr, { mode: 0o600 });
    const files = (await readdir(resultsDirectory)).filter(name => name.endsWith(`.${runId}.json`));
    if (files.length !== 1) throw new Error("Official aggregate result file was not uniquely produced.");
    const officialFile = join(resultsDirectory, files[0]);
    const officialText = await readFile(officialFile, "utf8");
    const official = JSON.parse(officialText);
    const groups = ["completed_ids", "incomplete_ids", "empty_patch_ids", "resolved_ids", "unresolved_ids", "error_ids", "submitted_ids"];
    if (groups.some(key => !Array.isArray(official[key]) || new Set(official[key]).size !== official[key].length ||
        official[key].some(id => !ids.includes(id))) ||
        official.submitted_ids.length !== seen.size || official.submitted_ids.some(id => !seen.has(id)) ||
        official.resolved_ids.some(id => !seen.has(id)) || official.total_instances !== ids.length ||
        official.resolved_instances !== official.resolved_ids.length ||
        official.unresolved_instances !== official.unresolved_ids.length ||
        official.error_instances !== official.error_ids.length ||
        official.resolved_ids.some(id => !official.completed_ids.includes(id) || official.unresolved_ids.includes(id)) ||
        official.unresolved_ids.some(id => !official.completed_ids.includes(id)) ||
        official.empty_patch_ids.some(id => official.completed_ids.includes(id) || official.error_ids.includes(id))) {
      throw new Error("Official result coverage mismatch.");
    }
    report.official = { file: officialFile, sha256: hash(officialText), result: official };
    report.evaluationDetails = [];
    for (const id of [...new Set([...official.completed_ids, ...official.error_ids])]) {
      const prediction = predictions.find(item => item.instance_id === id);
      const directory = join(output, "logs/run_evaluation", runId, prediction.model_name_or_path.replaceAll("/", "__"), id);
      const evidence = { instance_id: id, officialError: official.error_ids.includes(id), files: [] };
      try {
        for (const name of await readdir(directory)) {
          if (!["report.json", "test_output.txt", "run_instance.log", "eval.sh", "patch.diff"].includes(name)) continue;
          const file = await cachePath(join(directory, name));
          const bytes = await readFile(file);
          evidence.files.push({ file, sha256: hash(bytes), bytes: bytes.length });
        }
        const perCase = await cachePath(join(directory, "report.json"));
        const details = JSON.parse(await readFile(perCase, "utf8"))[id];
        Object.assign(evidence, { report: perCase, resolved: details?.resolved,
          patchSuccessfullyApplied: details?.patch_successfully_applied === true,
          testStatusAvailable: typeof details?.tests_status === "object" && details.tests_status !== null,
          testsStatus: details?.tests_status ?? null });
      } catch { evidence.reportUnavailable = true; }
      report.evaluationDetails.push(evidence);
    }
    const accounted = new Set([...official.resolved_ids, ...official.unresolved_ids, ...official.empty_patch_ids]);
    report.gradingComplete = seen.size === ids.length && ids.every(id => accounted.has(id)) &&
      !official.error_ids.length && !official.incomplete_ids.length &&
      report.evaluationDetails.every(item => item.patchSuccessfullyApplied && item.testStatusAvailable);
    report.status = report.gradingComplete ? "graded-small-sample" : "official-results-with-incomplete-evaluation";
  } catch (error) {
    report.status = signal?.aborted ? "cancelled" : "grading-blocked-or-failed";
    // No inherited OAuth or model credentials reach the grader process. Retain bounded official diagnostics.
    if (typeof error.stdout === "string") await writeFile(join(output, "stdout.log"), error.stdout, { mode: 0o600 });
    if (typeof error.stderr === "string") await writeFile(join(output, "stderr.log"), error.stderr, { mode: 0o600 });
    report.error = { code: String(error.code ?? error.name ?? "GRADING_FAILED").slice(0, 100),
      stage: report.status === "cancelled" ? "cancelled" : report.command ? "official-grader" : "preflight",
      message: report.command ? "Official grader did not produce verified aggregate results; inspect bounded logs." : String(error.message).slice(0, 700) };
  } finally {
    await cleanupOwnContainers();
    report.lifecycleComplete = report.command !== undefined && report.containerCleanup?.errors.length === 0;
    if (report.gradingComplete && !report.lifecycleComplete) report.status = "graded-with-cleanup-incomplete";
    report.durationMs = Math.round(performance.now() - start); report.finishedAt = new Date().toISOString(); await save();
  }
  return { report, output };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--report") throw new Error("Use --report PATH to an actual Harness inference report.");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Operator cancelled official grading."));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await gradeSwebench({ inferenceReport: args[1], signal: controller.signal });
    console.log(JSON.stringify({ status: result.report.status, output: result.output, official: result.report.official?.file ?? null }));
    process.exitCode = result.report.gradingComplete && result.report.lifecycleComplete ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
