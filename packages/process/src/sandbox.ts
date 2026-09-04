import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type {
  SandboxMode,
  SandboxNetworkIsolation,
  SandboxOsIsolation,
  SandboxProviderId,
  SandboxRuntimeStatus,
} from "@daoyin/harness-protocol";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const PROBE_CANDIDATES = ["/usr/bin/true", "/bin/true"] as const;
const SYSTEM_READ_PATHS = ["/usr", "/bin", "/lib", "/lib64", "/etc"] as const;

export interface SandboxExecutionPolicy {
  requested: boolean;
  allowNetwork: boolean;
  readOnlyPaths?: string[];
}

export interface SandboxWrapInput {
  executable: string;
  args: string[];
  cwd: string;
  workspaceRoot: string;
  policy: SandboxExecutionPolicy;
}

export interface SandboxWrappedCommand {
  executable: string;
  args: string[];
  provider: SandboxProviderId;
  osIsolation: SandboxOsIsolation;
  networkIsolation: SandboxNetworkIsolation;
  environmentOverrides: NodeJS.ProcessEnv;
}

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  readonly probeExecutable: string | null;
  status(mode: SandboxMode): SandboxRuntimeStatus;
  wrap(input: SandboxWrapInput): Promise<SandboxWrappedCommand>;
}

class NoSandboxProvider implements SandboxProvider {
  public readonly id = "none" as const;
  public readonly probeExecutable = null;
  readonly #reason: string;

  public constructor(reason: string) {
    this.#reason = reason;
  }

  public status(mode: SandboxMode): SandboxRuntimeStatus {
    return {
      mode,
      provider: "none",
      available: false,
      osIsolation: "none",
      networkIsolation: "none",
      reason: this.#reason,
    };
  }

  public async wrap(input: SandboxWrapInput): Promise<SandboxWrappedCommand> {
    return {
      executable: input.executable,
      args: [...input.args],
      provider: "none",
      osIsolation: "none",
      networkIsolation: "none",
      environmentOverrides: {},
    };
  }
}

async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed candidate.
    }
  }
  return null;
}

async function existingPaths(candidates: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      result.push(candidate);
    } catch {
      // Optional system path is absent on this distribution.
    }
  }
  return result;
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function targetParentDirectories(target: string): string[] {
  const normalized = path.resolve(target);
  const directories: string[] = [];
  let current = path.dirname(normalized);
  while (current !== path.parse(current).root) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function mountAlreadyCovered(candidate: string, mounts: readonly string[]): boolean {
  return mounts.some((mount) => inside(mount, candidate));
}

async function normalizedExtraMounts(paths: readonly string[], workspaceRoot: string, systemMounts: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const raw of paths) {
    const candidate = path.resolve(raw);
    if (inside(workspaceRoot, candidate) || mountAlreadyCovered(candidate, systemMounts)) continue;
    try {
      const info = await stat(candidate);
      const mount = info.isDirectory() ? candidate : path.dirname(candidate);
      if (!mountAlreadyCovered(mount, result)) result.push(mount);
    } catch {
      throw Object.assign(new Error(`Sandbox read-only path does not exist: ${candidate}`), { code: "SANDBOX_PATH_INVALID" });
    }
  }
  return result;
}

export class BubblewrapSandboxProvider implements SandboxProvider {
  public readonly id = "bubblewrap" as const;
  public readonly probeExecutable: string;
  readonly #binary: string;
  readonly #systemMounts: string[];

  private constructor(binary: string, probeExecutable: string, systemMounts: string[]) {
    this.#binary = binary;
    this.probeExecutable = probeExecutable;
    this.#systemMounts = systemMounts;
  }

  public static async create(binary: string, probeExecutable: string): Promise<BubblewrapSandboxProvider> {
    return new BubblewrapSandboxProvider(binary, probeExecutable, await existingPaths(SYSTEM_READ_PATHS));
  }

  public status(mode: SandboxMode): SandboxRuntimeStatus {
    return {
      mode,
      provider: "bubblewrap",
      available: true,
      osIsolation: "bubblewrap",
      networkIsolation: "blocked",
      reason: "Linux Bubblewrap provider passed startup discovery; runtime probe is required before use.",
    };
  }

  public async wrap(input: SandboxWrapInput): Promise<SandboxWrappedCommand> {
    if (!input.policy.requested) {
      return {
        executable: input.executable,
        args: [...input.args],
        provider: "none",
        osIsolation: "none",
        networkIsolation: "none",
        environmentOverrides: {},
      };
    }

    const workspaceRoot = path.resolve(input.workspaceRoot);
    const cwd = path.resolve(input.cwd);
    if (!inside(workspaceRoot, cwd)) {
      throw Object.assign(new Error("Sandbox cwd escapes the selected workspace."), { code: "SANDBOX_CWD_DENIED" });
    }

    const extraMounts = await normalizedExtraMounts(input.policy.readOnlyPaths ?? [], workspaceRoot, this.#systemMounts);
    const createdDirs = new Set<string>();
    const args: string[] = ["--die-with-parent", "--new-session", "--unshare-all"];
    if (input.policy.allowNetwork) args.push("--share-net");

    const ensureParents = (target: string): void => {
      for (const directory of targetParentDirectories(target)) {
        if (createdDirs.has(directory) || this.#systemMounts.includes(directory)) continue;
        args.push("--dir", directory);
        createdDirs.add(directory);
      }
    };

    for (const systemPath of this.#systemMounts) {
      args.push("--ro-bind", systemPath, systemPath);
    }
    ensureParents(workspaceRoot);
    args.push("--bind", workspaceRoot, workspaceRoot);
    for (const mount of extraMounts) {
      ensureParents(mount);
      args.push("--ro-bind", mount, mount);
    }
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home");
    args.push("--chdir", cwd, "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp");
    args.push("--", input.executable, ...input.args);

    return {
      executable: this.#binary,
      args,
      provider: "bubblewrap",
      osIsolation: "bubblewrap",
      networkIsolation: input.policy.allowNetwork ? "none" : "blocked",
      environmentOverrides: { HOME: "/tmp/home", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" },
    };
  }
}

export async function discoverSandboxProvider(mode: SandboxMode): Promise<SandboxProvider> {
  if (mode === "off") return new NoSandboxProvider("OS sandbox disabled by runtime mode.");
  if (process.platform !== "linux") {
    return new NoSandboxProvider(`No OS sandbox provider is implemented for ${process.platform} yet.`);
  }
  const binary = await firstExecutable(BWRAP_CANDIDATES);
  if (binary === null) return new NoSandboxProvider("Bubblewrap executable was not found in /usr/bin/bwrap or /bin/bwrap.");
  const probeExecutable = await firstExecutable(PROBE_CANDIDATES);
  if (probeExecutable === null) return new NoSandboxProvider("Bubblewrap was found, but no fixed probe executable was available.");
  return BubblewrapSandboxProvider.create(binary, probeExecutable);
}

export function unavailableSandboxStatus(mode: SandboxMode, reason: string): SandboxRuntimeStatus {
  return {
    mode,
    provider: "none",
    available: false,
    osIsolation: "none",
    networkIsolation: "none",
    reason,
  };
}
