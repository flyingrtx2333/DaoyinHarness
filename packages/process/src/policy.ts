import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ProcessRisk } from "@daoyin/harness-protocol";
import type { SandboxExecutionPolicy } from "./sandbox.js";

export type ProcessOperation =
  | "node_version"
  | "git_status"
  | "git_diff_check"
  | "git_diff_stat"
  | "git_log_recent"
  | "package_script";

export interface ProcessCommandPlan {
  operation: ProcessOperation;
  executable: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  fingerprint: string;
  risk: ProcessRisk;
  approval: "auto" | "user_required";
  reason: string;
  timeoutMs: number;
  maxOutputBytes: number;
  sandbox: SandboxExecutionPolicy;
}

export interface PlanProcessOperationInput {
  operation: ProcessOperation;
  cwd?: string;
  limit?: number;
  script?: string;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function makePlan(input: Omit<ProcessCommandPlan, "fingerprint">): ProcessCommandPlan {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      risk: input.risk,
      sandbox: input.sandbox,
    }))
    .digest("hex");
  return { ...input, fingerprint };
}

async function resolveNpmCli(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }
  throw Object.assign(new Error("npm CLI could not be located for the requested package operation."), { code: "PROCESS_NPM_UNAVAILABLE" });
}

export async function planProcessOperation(input: PlanProcessOperationInput, npmCliPath?: string): Promise<ProcessCommandPlan> {
  const cwd = input.cwd?.trim() || ".";
  switch (input.operation) {
    case "node_version":
      return makePlan({
        operation: input.operation,
        executable: process.execPath,
        args: ["--version"],
        cwd,
        displayCommand: "node --version",
        risk: "inspect",
        approval: "auto",
        reason: "Reads local runtime version only and does not execute workspace code.",
        timeoutMs: 10_000,
        maxOutputBytes: 20_000,
        sandbox: { requested: true, allowNetwork: false, readOnlyPaths: [path.dirname(process.execPath)] },
      });
    case "git_status":
      return makePlan({
        operation: input.operation,
        executable: "git",
        args: ["-c", "core.fsmonitor=false", "status", "--short", "--branch"],
        cwd,
        displayCommand: "git status --short --branch",
        risk: "inspect",
        approval: "auto",
        reason: "Reads Git working-tree metadata without modifying repository state.",
        timeoutMs: 20_000,
        maxOutputBytes: 120_000,
        sandbox: { requested: true, allowNetwork: false },
      });
    case "git_diff_check":
      return makePlan({
        operation: input.operation,
        executable: "git",
        args: ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--check"],
        cwd,
        displayCommand: "git diff --check",
        risk: "inspect",
        approval: "auto",
        reason: "Checks whitespace/conflict markers without applying changes.",
        timeoutMs: 20_000,
        maxOutputBytes: 120_000,
        sandbox: { requested: true, allowNetwork: false },
      });
    case "git_diff_stat":
      return makePlan({
        operation: input.operation,
        executable: "git",
        args: ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--stat"],
        cwd,
        displayCommand: "git diff --stat",
        risk: "inspect",
        approval: "auto",
        reason: "Reads a bounded Git diff summary without exposing full file contents or modifying state.",
        timeoutMs: 20_000,
        maxOutputBytes: 120_000,
        sandbox: { requested: true, allowNetwork: false },
      });
    case "git_log_recent": {
      const limit = Math.max(1, Math.min(50, Number.isInteger(input.limit) ? Number(input.limit) : 10));
      return makePlan({
        operation: input.operation,
        executable: "git",
        args: ["-c", "core.fsmonitor=false", "log", "--oneline", `-${String(limit)}`],
        cwd,
        displayCommand: `git log --oneline -${String(limit)}`,
        risk: "inspect",
        approval: "auto",
        reason: "Reads recent commit summaries without changing repository state.",
        timeoutMs: 20_000,
        maxOutputBytes: 120_000,
        sandbox: { requested: true, allowNetwork: false },
      });
    }
    case "package_script": {
      const script = input.script?.trim() ?? "";
      if (!/^[A-Za-z0-9:_-]{1,80}$/u.test(script)) {
        throw Object.assign(new Error("Package script name is invalid."), { code: "PROCESS_INPUT_INVALID" });
      }
      const npmCli = await resolveNpmCli(npmCliPath);
      const args = [npmCli, "run", script];
      return makePlan({
        operation: input.operation,
        executable: process.execPath,
        args,
        cwd,
        displayCommand: `npm run ${quote(script)}`,
        risk: "workspace_exec",
        approval: "user_required",
        reason: "Package scripts execute workspace-controlled code and can have side effects outside the files the Agent intends to change. One-shot user approval is required for the exact command fingerprint.",
        timeoutMs: 180_000,
        maxOutputBytes: 200_000,
        sandbox: {
          requested: true,
          allowNetwork: false,
          readOnlyPaths: [path.dirname(process.execPath), path.dirname(path.dirname(npmCli))],
        },
      });
    }
  }
}
