import type { JsonValue, ProcessPermissionRequest } from "@daoyin/harness-protocol";
import {
  planProcessOperation,
  type ProcessPermissionStore,
  type ProcessService,
} from "@daoyin/harness-process";
import type { Workspace } from "@daoyin/harness-workspace";
import type { ToolDefinition, ToolExecutionContext, ToolSuccess } from "./registry.js";

const INSPECT_OPERATIONS = ["node_version", "git_status", "git_diff_check", "git_diff_stat", "git_log_recent"] as const;

const objectSchema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function success(toolName: string, summary: string, result: JsonValue): ToolSuccess {
  return { ok: true, summary, evidence: { schemaVersion: 1, toolName, result, artifacts: [], diagnostics: [] } };
}

function optionalCwd(input: Record<string, unknown>): string {
  const value = input.cwd;
  if (value === undefined) return ".";
  if (typeof value !== "string" || value.trim().length === 0) throw Object.assign(new Error("cwd must be a non-empty workspace-relative string."), { code: "TOOL_INPUT_INVALID" });
  return value.trim();
}

function inspectOperation(input: Record<string, unknown>): typeof INSPECT_OPERATIONS[number] {
  const value = input.operation;
  if (typeof value !== "string" || !INSPECT_OPERATIONS.includes(value as typeof INSPECT_OPERATIONS[number])) {
    throw Object.assign(new Error(`operation must be one of: ${INSPECT_OPERATIONS.join(", ")}.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value as typeof INSPECT_OPERATIONS[number];
}

function permissionDetails(request: ProcessPermissionRequest): JsonValue {
  return {
    permissionRequestId: request.id,
    operation: request.operation,
    displayCommand: request.displayCommand,
    risk: request.risk,
    reason: request.reason,
    status: request.status,
    fingerprint: request.fingerprint,
  };
}

async function executePlan(
  service: ProcessService,
  plan: Awaited<ReturnType<typeof planProcessOperation>>,
  signal: AbortSignal,
): Promise<ToolSuccess> {
  const result = await service.execute({
    executable: plan.executable,
    args: plan.args,
    cwd: plan.cwd,
    timeoutMs: plan.timeoutMs,
    maxOutputBytes: plan.maxOutputBytes,
    sandbox: plan.sandbox,
  }, signal);
  if (result.cancelled) throw Object.assign(new Error("Process execution was cancelled."), { code: "TOOL_CANCELLED" });
  if (result.timedOut) {
    throw Object.assign(new Error(`Process timed out while running ${plan.displayCommand}.`), {
      code: "PROCESS_TIMEOUT",
      details: { displayCommand: plan.displayCommand, durationMs: result.durationMs },
    });
  }
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`Process exited with code ${String(result.exitCode)}: ${plan.displayCommand}`), {
      code: "PROCESS_EXIT_NONZERO",
      details: {
        displayCommand: plan.displayCommand,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.outputTruncated,
        durationMs: result.durationMs,
      },
    });
  }
  return success("process_run", `Process completed: ${plan.displayCommand}.`, {
    operation: plan.operation,
    displayCommand: plan.displayCommand,
    risk: plan.risk,
    sandboxRequested: result.sandboxRequested,
    sandboxProvider: result.sandboxProvider,
    sandboxReason: result.sandboxReason,
    osIsolation: result.osIsolation,
    networkIsolation: result.networkIsolation,
    permissionModel: plan.approval === "user_required" ? "exact_one_shot" : "automatic_read_only",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
  });
}

async function requirePermission(
  store: ProcessPermissionStore,
  plan: Awaited<ReturnType<typeof planProcessOperation>>,
  context: ToolExecutionContext,
): Promise<void> {
  const consumed = await store.consumeApproved(plan.fingerprint, context.accountId, context.scopeId, context.sessionId);
  if (consumed !== undefined) return;
  const request = await store.request({
    accountId: context.accountId,
    resourceScopeId: context.scopeId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    operation: plan.operation,
    displayCommand: plan.displayCommand,
    fingerprint: plan.fingerprint,
    risk: plan.risk,
    reason: plan.reason,
  });
  if (request.status === "denied") {
    throw Object.assign(new Error(`User denied process execution: ${plan.displayCommand}`), {
      code: "PROCESS_PERMISSION_DENIED",
      retryable: false,
      details: permissionDetails(request),
    });
  }
  throw Object.assign(new Error(`User approval is required before running ${plan.displayCommand}.`), {
    code: "PROCESS_APPROVAL_REQUIRED",
    retryable: true,
    details: permissionDetails(request),
  });
}

export interface ProcessToolOptions {
  allowedPackageScripts?: string[];
  npmCliPath?: string;
}

export function createProcessTools(
  service: ProcessService,
  permissions: ProcessPermissionStore,
  workspace: Workspace,
  options: ProcessToolOptions = {},
): ToolDefinition[] {
  const allowedPackageScripts = new Set(options.allowedPackageScripts ?? ["typecheck", "lint", "test", "build"]);
  return [
    {
      name: "process_inspect",
      description: "Run one policy-defined read-only local process inspection such as Node version or bounded Git status/diff/log. This never exposes arbitrary shell text or arbitrary arguments.",
      category: "process",
      mutating: false,
      inputSchema: objectSchema({
        operation: { type: "string", enum: [...INSPECT_OPERATIONS] },
        cwd: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      }, ["operation"]),
      async execute(input, signal) {
        const operation = inspectOperation(input);
        const limit = input.limit === undefined ? undefined : Number(input.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
          throw Object.assign(new Error("limit must be an integer between 1 and 50."), { code: "TOOL_INPUT_INVALID" });
        }
        const plan = await planProcessOperation({
          operation,
          cwd: optionalCwd(input),
          ...(limit === undefined ? {} : { limit }),
        });
        if (plan.approval !== "auto" || plan.risk !== "inspect") {
          throw Object.assign(new Error("Inspect operation was not classified as automatic read-only execution."), { code: "PROCESS_POLICY_DENIED" });
        }
        const result = await executePlan(service, plan, signal);
        return { ...result, evidence: { ...result.evidence, toolName: "process_inspect" } };
      },
    },
    {
      name: "run_package_script",
      description: "Run one allowlisted npm package script through the Process Service. Package scripts execute workspace-controlled code, so the exact command requires one-shot user approval before execution.",
      category: "process",
      mutating: true,
      inputSchema: objectSchema({
        script: { type: "string", enum: [...allowedPackageScripts] },
        cwd: { type: "string" },
      }, ["script"]),
      async execute(input, signal, context) {
        const script = input.script;
        if (typeof script !== "string" || !allowedPackageScripts.has(script)) {
          throw Object.assign(new Error("Package script is not allowlisted by the runtime."), { code: "PROCESS_POLICY_DENIED" });
        }
        const cwd = optionalCwd(input);
        const packagePath = cwd === "." ? "package.json" : `${cwd.replace(/\\/gu, "/").replace(/\/$/u, "")}/package.json`;
        const packageJson = JSON.parse(await workspace.readText(packagePath)) as { scripts?: Record<string, unknown> };
        if (typeof packageJson.scripts?.[script] !== "string") {
          throw Object.assign(new Error(`Package script ${script} is not declared in ${packagePath}.`), { code: "PROCESS_SCRIPT_MISSING" });
        }
        const plan = await planProcessOperation({ operation: "package_script", cwd, script }, options.npmCliPath);
        await requirePermission(permissions, plan, context);
        const result = await executePlan(service, plan, signal);
        return { ...result, evidence: { ...result.evidence, toolName: "run_package_script" } };
      },
    },
  ];
}
