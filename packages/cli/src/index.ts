#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError, parseArgs } from "./args.js";
import { startHarness } from "./runtime.js";

const VERSION = "0.1.0";

const HELP = `DaoyinHarness ${VERSION}

用法：daoyin-harness [选项]

  --port <端口>       使用指定端口；被占用时直接失败
  --no-open           启动后不自动打开浏览器
  --data-dir <目录>   指定本地运行数据目录
  --workspace <目录>  指定 Agent 可访问的本地工作区；默认当前目录
  --sandbox <模式>   auto|required|off；默认 auto，required 不允许静默降级
  --mcp <id>=<URL>    显式连接远程/回环 Streamable HTTP MCP；可重复
  --mcp-bearer-env <id>=<环境变量>  从进程环境读取该 MCP 的静态 Bearer Token
  --log-level <级别>  fatal|error|warn|info|debug|trace|silent
  --help, -h           显示帮助
  --version, -v        显示版本`;

function printableError(error: unknown): { code: string; message: string } {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "STARTUP_FAILED";
    const message = code === "EADDRINUSE" ? "指定端口已被占用。" : error.message;
    return { code, message };
  }
  return { code: "STARTUP_FAILED", message: "本地运行时启动失败。" };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args, join(homedir(), ".daoyin-harness"));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  const running = await startHarness(options, VERSION, publicDir);
  console.log(`DaoyinHarness ${VERSION} 已启动：${running.url}`);
  console.log(`工作区：${options.workspaceRoot}`);
  console.log(`数据目录：${options.dataDir}`);

  const shutdown = async (): Promise<void> => {
    await running.app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error: unknown) => {
    const printable = printableError(error);
    console.error(`[${printable.code}] ${printable.message}`);
    process.exitCode = 1;
  });
}

export { parseArgs, startHarness };
