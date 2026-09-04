import { resolve } from "node:path";
import type { SandboxMode } from "@daoyin/harness-protocol";

export const DEFAULT_PORT = 4677;
export const LAST_SCANNED_PORT = 4699;
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CliMcpServerOption {
  id: string;
  url: string;
  bearerEnv?: string;
}

export interface CliOptions {
  port?: number;
  openBrowser: boolean;
  dataDir: string;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  mcpServers: CliMcpServerOption[];
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

function assignment(value: string, flag: string): { id: string; value: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliError("INVALID_ARGUMENT", `${flag} 必须使用 <id>=<值> 格式。`);
  }
  const id = value.slice(0, separator).trim();
  const assigned = value.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(id)) {
    throw new CliError("INVALID_ARGUMENT", `${flag} 的 MCP id 无效：${id}`);
  }
  return { id, value: assigned };
}

export function parseArgs(args: readonly string[], defaultDataDir: string, defaultWorkspaceRoot = process.cwd()): CliOptions {
  const result: CliOptions = {
    openBrowser: true,
    dataDir: defaultDataDir,
    workspaceRoot: resolve(defaultWorkspaceRoot),
    sandboxMode: "auto",
    mcpServers: [],
    logLevel: "info",
    help: false,
    version: false,
  };
  const mcpBearerEnvs = new Map<string, string>();

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
      case "--mcp": {
        const parsed = assignment(nextValue(args, index, arg), arg);
        if (result.mcpServers.some((server) => server.id === parsed.id)) {
          throw new CliError("INVALID_ARGUMENT", `MCP server id 重复：${parsed.id}`);
        }
        result.mcpServers.push({ id: parsed.id, url: parsed.value });
        index += 1;
        break;
      }
      case "--mcp-bearer-env": {
        const parsed = assignment(nextValue(args, index, arg), arg);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(parsed.value)) {
          throw new CliError("INVALID_ARGUMENT", `${arg} 的环境变量名无效：${parsed.value}`);
        }
        if (mcpBearerEnvs.has(parsed.id)) {
          throw new CliError("INVALID_ARGUMENT", `MCP Bearer env 重复：${parsed.id}`);
        }
        mcpBearerEnvs.set(parsed.id, parsed.value);
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

  for (const [id, bearerEnv] of mcpBearerEnvs) {
    const server = result.mcpServers.find((candidate) => candidate.id === id);
    if (server === undefined) {
      throw new CliError("INVALID_ARGUMENT", `--mcp-bearer-env 引用了未配置的 MCP server：${id}`);
    }
    server.bearerEnv = bearerEnv;
  }

  return result;
}
