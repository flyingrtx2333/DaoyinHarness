import { spawn } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  SandboxMode,
  SandboxNetworkIsolation,
  SandboxOsIsolation,
  SandboxProviderId,
  SandboxRuntimeStatus,
} from "@daoyin/harness-protocol";
import {
  discoverSandboxProvider,
  unavailableSandboxStatus,
  type SandboxExecutionPolicy,
  type SandboxProvider,
} from "./sandbox.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 120_000;
const MAX_ARGS = 64;
const MAX_ARG_CHARACTERS = 4_000;

export interface ProcessServiceOptions {
  sandboxMode?: SandboxMode;
}

export interface ProcessExecutionRequest {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandbox?: SandboxExecutionPolicy;
}

export interface ProcessExecutionResult {
  executable: string;
  args: string[];
  cwd: string;
  sandboxRequested: boolean;
  sandboxProvider: SandboxProviderId;
  sandboxReason: string;
  osIsolation: SandboxOsIsolation;
  networkIsolation: SandboxNetworkIsolation;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

function allowedEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const keys = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"];
  const env = Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    GIT_CEILING_DIRECTORIES: workspaceRoot,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

function appendBounded(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.byteLength + chunk.byteLength <= limit) return { value: Buffer.concat([current, chunk]), truncated: false };
  const combined = Buffer.concat([current, chunk]);
  return { value: combined.subarray(Math.max(0, combined.byteLength - limit)), truncated: true };
}

function validateRequest(request: ProcessExecutionRequest): void {
  if (!request.executable.trim()) throw Object.assign(new Error("Process executable cannot be empty."), { code: "PROCESS_INPUT_INVALID" });
  if (request.executable.includes("\u0000")) throw Object.assign(new Error("Process executable contains an invalid NUL character."), { code: "PROCESS_INPUT_INVALID" });
  if (request.args.length > MAX_ARGS) throw Object.assign(new Error(`Process argument count exceeds ${String(MAX_ARGS)}.`), { code: "PROCESS_INPUT_INVALID" });
  for (const arg of request.args) {
    if (arg.includes("\u0000") || arg.length > MAX_ARG_CHARACTERS) {
      throw Object.assign(new Error("Process argument is invalid or too large."), { code: "PROCESS_INPUT_INVALID" });
    }
  }
}

async function runSpawn(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SpawnResult> {
  if (signal.aborted) throw Object.assign(new Error("Process execution was cancelled before start."), { code: "TOOL_CANCELLED" });
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      const next = appendBounded(stdout, chunk, maxOutputBytes);
      stdout = next.value;
      outputTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      const next = appendBounded(stderr, chunk, maxOutputBytes);
      stderr = next.value;
      outputTruncated ||= next.truncated;
    });

    const stop = (): void => {
      cancelled = signal.aborted;
      child.kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(Object.assign(error, { code: (error as NodeJS.ErrnoException).code ?? "PROCESS_START_FAILED" }));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        cancelled,
        outputTruncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export class ProcessService {
  readonly #root: string;
  readonly #sandboxMode: SandboxMode;
  readonly #sandboxProvider: SandboxProvider | null;
  readonly #sandboxStatus: SandboxRuntimeStatus;

  private constructor(root: string, sandboxMode: SandboxMode, sandboxProvider: SandboxProvider | null, sandboxStatus: SandboxRuntimeStatus) {
    this.#root = root;
    this.#sandboxMode = sandboxMode;
    this.#sandboxProvider = sandboxProvider;
    this.#sandboxStatus = sandboxStatus;
  }

  public static async create(root: string, options: ProcessServiceOptions = {}): Promise<ProcessService> {
    const resolved = await realpath(path.resolve(root));
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) throw Object.assign(new Error("Process workspace root must be a directory."), { code: "PROCESS_ROOT_INVALID" });

    const sandboxMode = options.sandboxMode ?? "auto";
    const discovered = await discoverSandboxProvider(sandboxMode);
    let provider: SandboxProvider | null = discovered.id === "none" ? null : discovered;
    let sandboxStatus = discovered.status(sandboxMode);

    if (provider !== null && provider.probeExecutable !== null) {
      try {
        const wrapped = await provider.wrap({
          executable: provider.probeExecutable,
          args: [],
          cwd: resolved,
          workspaceRoot: resolved,
          policy: { requested: true, allowNetwork: false },
        });
        const probe = await runSpawn(
          wrapped.executable,
          wrapped.args,
          resolved,
          { ...allowedEnvironment(resolved), ...wrapped.environmentOverrides },
          new AbortController().signal,
          5_000,
          20_000,
        );
        if (probe.exitCode !== 0 || probe.timedOut) {
          throw new Error(`Bubblewrap startup probe exited with code ${String(probe.exitCode)}${probe.timedOut ? " after timeout" : ""}.`);
        }
        sandboxStatus = {
          ...sandboxStatus,
          reason: "Bubblewrap startup probe passed; sandboxed process operations use filesystem/process namespaces with network blocked by default.",
        };
      } catch (error) {
        provider = null;
        sandboxStatus = unavailableSandboxStatus(
          sandboxMode,
          `Bubblewrap was discovered but failed its startup probe: ${error instanceof Error ? error.message : "unknown failure"}`,
        );
      }
    }

    if (sandboxMode === "required" && provider === null) {
      throw Object.assign(new Error(`OS sandbox is required but unavailable: ${sandboxStatus.reason}`), {
        code: "SANDBOX_UNAVAILABLE",
        details: sandboxStatus,
      });
    }
    return new ProcessService(resolved, sandboxMode, provider, sandboxStatus);
  }

  public get root(): string {
    return this.#root;
  }

  public get sandboxStatus(): SandboxRuntimeStatus {
    return { ...this.#sandboxStatus };
  }

  public async resolveCwd(relativeCwd = "."): Promise<string> {
    if (path.isAbsolute(relativeCwd)) throw Object.assign(new Error("Process cwd must be workspace-relative."), { code: "PROCESS_CWD_DENIED" });
    const candidate = path.resolve(this.#root, relativeCwd);
    const realCandidate = await realpath(candidate);
    const relative = path.relative(this.#root, realCandidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Process cwd escapes the selected workspace."), { code: "PROCESS_CWD_DENIED" });
    }
    const candidateStat = await stat(realCandidate);
    if (!candidateStat.isDirectory()) throw Object.assign(new Error("Process cwd is not a directory."), { code: "PROCESS_CWD_INVALID" });
    return realCandidate;
  }

  public async execute(request: ProcessExecutionRequest, signal: AbortSignal): Promise<ProcessExecutionResult> {
    validateRequest(request);
    const cwd = await this.resolveCwd(request.cwd ?? ".");
    const timeoutMs = Math.max(100, Math.min(300_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const maxOutputBytes = Math.max(1_024, Math.min(1_000_000, request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));
    const sandboxPolicy = request.sandbox ?? { requested: false, allowNetwork: false };

    let executable = request.executable;
    let args = [...request.args];
    let provider: SandboxProviderId = "none";
    let osIsolation: SandboxOsIsolation = "none";
    let networkIsolation: SandboxNetworkIsolation = "none";
    let environmentOverrides: NodeJS.ProcessEnv = {};
    let sandboxReason = sandboxPolicy.requested ? this.#sandboxStatus.reason : "Sandbox was not requested by this named operation.";

    if (sandboxPolicy.requested && this.#sandboxProvider !== null && this.#sandboxMode !== "off") {
      const wrapped = await this.#sandboxProvider.wrap({
        executable: request.executable,
        args: request.args,
        cwd,
        workspaceRoot: this.#root,
        policy: sandboxPolicy,
      });
      executable = wrapped.executable;
      args = wrapped.args;
      provider = wrapped.provider;
      osIsolation = wrapped.osIsolation;
      networkIsolation = wrapped.networkIsolation;
      environmentOverrides = wrapped.environmentOverrides;
      sandboxReason = this.#sandboxStatus.reason;
    } else if (sandboxPolicy.requested && this.#sandboxMode === "required") {
      throw Object.assign(new Error(`Sandboxed execution is required but unavailable: ${this.#sandboxStatus.reason}`), {
        code: "SANDBOX_UNAVAILABLE",
        details: this.#sandboxStatus,
      });
    }

    const result = await runSpawn(
      executable,
      args,
      cwd,
      { ...allowedEnvironment(this.#root), ...environmentOverrides },
      signal,
      timeoutMs,
      maxOutputBytes,
    );
    return {
      executable: request.executable,
      args: [...request.args],
      cwd,
      sandboxRequested: sandboxPolicy.requested,
      sandboxProvider: provider,
      sandboxReason,
      osIsolation,
      networkIsolation,
      ...result,
    };
  }
}
