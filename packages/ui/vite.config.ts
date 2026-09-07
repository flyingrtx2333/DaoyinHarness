import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
if (typeof version !== "string" || !version.trim()) throw new Error("Workbench package version missing");

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export default defineConfig(({ command }) => {
  const revision = gitOutput(["rev-parse", "HEAD"]);
  const clean = command === "build" && gitOutput(["status", "--porcelain", "--untracked-files=normal"]) === "";
  const buildInfo = {
    version,
    revision,
    builtAt: command === "build" ? new Date().toISOString() : null,
    channel: command === "serve" ? "development" : revision && clean ? "release" : "preview",
  };
  return {
    plugins: [react()],
    define: { __HARNESS_BUILD_INFO__: JSON.stringify(buildInfo) },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": "http://127.0.0.1:4677",
      },
    },
  };
});
