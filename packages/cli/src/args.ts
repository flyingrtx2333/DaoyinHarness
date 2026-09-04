import { resolve } from "node:path";
import type { SandboxMode } from "@daoyin/harness-protocol";

export const DEFAULT_PORT = 4677;
export const LAST_SCANNED_PORT = 4699;
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CliOptions {
  port?: number;
  openBrowser: boolean;
  dataDir: string;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
}

export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function nextValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError("INVALID_ARGUMENT", `${flag} 缺少参数。`);
  }
  return value;
}

export function parseArgs(args: readonly string[], defaultDataDir: string, defaultWorkspaceRoot = process.cwd()): CliOptions {
  const result: CliOptions = {
    openBrowser: true,
    dataDir: defaultDataDir,
    workspaceRoot: resolve(defaultWorkspaceRoot),
    sandboxMode: "auto",
    logLevel: "info",
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--port": {
        const raw = nextValue(args, index, arg);
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new CliError("INVALID_PORT", `端口必须是 1 到 65535 之间的整数，收到：${raw}`);
        }
        result.port = port;
        index += 1;
        break;
      }
      case "--data-dir":
        result.dataDir = resolve(nextValue(args, index, arg));
        index += 1;
        break;
      case "--workspace":
        result.workspaceRoot = resolve(nextValue(args, index, arg));
        index += 1;
        break;
      case "--sandbox": {
        const mode = nextValue(args, index, arg);
        if (mode !== "auto" && mode !== "required" && mode !== "off") {
          throw new CliError("INVALID_SANDBOX_MODE", `sandbox 必须是 auto、required 或 off，收到：${mode}`);
        }
        result.sandboxMode = mode;
        index += 1;
        break;
      }
      case "--log-level": {
        const level = nextValue(args, index, arg);
        if (!LOG_LEVELS.includes(level as LogLevel)) {
          throw new CliError("INVALID_LOG_LEVEL", `不支持的日志级别：${level}`);
        }
        result.logLevel = level as LogLevel;
        index += 1;
        break;
      }
      case "--no-open":
        result.openBrowser = false;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--version":
      case "-v":
        result.version = true;
        break;
      default:
        throw new CliError("UNKNOWN_ARGUMENT", `未知参数：${arg}`);
    }
  }

  return result;
}
