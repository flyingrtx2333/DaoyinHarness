import { createHash } from "node:crypto";

// Declaration files are read as data. No imports, evaluation or project hooks
// run during inspection. Installation is a separate explicit preparation action.
export const PROJECT_DECLARATIONS = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version",
  "pyproject.toml", "setup.cfg", "setup.py", "requirements.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", ".python-version",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "Dockerfile", ".tool-versions"] as const;
export const VERSION_PROBES = ["node", "npm", "python", "python3", "pip", "pip3", "uv", "poetry", "go", "rustc", "cargo"] as const;
export interface RuntimeCatalogEntry { digest?: unknown; image?: unknown; version?: unknown; capabilities?: unknown }
export function trustedRuntimeCatalog(catalog: Record<string, RuntimeCatalogEntry>): Array<{ id: string; digest: string; image: string | null; version: string | null; capabilities: string[] }> {
  return Object.entries(catalog).flatMap(([id, entry]) => typeof entry.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(entry.digest)
    ? [{ id, digest: entry.digest, image: typeof entry.image === "string" && entry.image.endsWith(`@${entry.digest}`) ? entry.image : null,
      version: typeof entry.version === "string" ? entry.version.slice(0, 160) : null,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.filter((value): value is string => typeof value === "string").slice(0, 32) : [] }] : []);
}
export function environmentCacheKey(imageDigest: string, declarations: Array<{ path: string; digest: string }>): string {
  return createHash("sha256").update(JSON.stringify([imageDigest, [...declarations].sort((a, b) => a.path.localeCompare(b.path))])).digest("hex");
}
export function declaredDependencyCommand(declarations: Array<{ path: string; content: string; truncated: boolean }>): { executable: string; args: string[] } | null {
  const paths = declarations.map(item => item.path);
  const families = [paths.includes("package.json"), paths.includes("requirements.txt") || paths.includes("pyproject.toml") || paths.includes("setup.py") || paths.includes("Pipfile"),
    paths.includes("go.mod"), paths.includes("Cargo.toml")].filter(Boolean).length;
  // Mixed projects require the model to select a declared installation explicitly
  // with process tools rather than guess which dependency graph to install.
  if (families !== 1) return null;
  const packageDeclaration = declarations.find(item => item.path === "package.json");
  if (packageDeclaration && !packageDeclaration.truncated) {
    try {
      const packageManager: unknown = (JSON.parse(packageDeclaration.content) as { packageManager?: unknown }).packageManager;
      if (typeof packageManager === "string" && !/^npm(?:@|$)/u.test(packageManager) &&
          !/^pnpm(?:@|$)/u.test(packageManager) && !/^yarn(?:@|$)/u.test(packageManager)) return null;
      if (typeof packageManager === "string" && /^pnpm(?:@|$)/u.test(packageManager)) return { executable: "pnpm", args: ["install", ...(paths.includes("pnpm-lock.yaml") ? ["--frozen-lockfile"] : [])] };
      if (typeof packageManager === "string" && /^yarn(?:@|$)/u.test(packageManager)) return { executable: "yarn", args: ["install", ...(paths.includes("yarn.lock") ? ["--immutable"] : [])] };
    } catch { return null; }
  } else if (packageDeclaration?.truncated) return null;
  if (paths.includes("pnpm-lock.yaml")) return { executable: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (paths.includes("yarn.lock")) return { executable: "yarn", args: ["install", "--immutable"] };
  if (paths.includes("package-lock.json") || paths.includes("npm-shrinkwrap.json")) return { executable: "npm", args: ["ci", "--no-audit", "--no-fund"] };
  if (paths.includes("package.json")) return { executable: "npm", args: ["install", "--no-audit", "--no-fund"] };
  if (paths.includes("uv.lock")) return { executable: "uv", args: ["sync", "--locked"] };
  if (paths.includes("poetry.lock")) return { executable: "poetry", args: ["install", "--no-interaction"] };
  if (paths.includes("Pipfile.lock")) return { executable: "pipenv", args: ["sync"] };
  if (paths.includes("requirements.txt")) return { executable: "python", args: ["-m", "pip", "install", "--user", "-r", "requirements.txt"] };
  if (paths.includes("pyproject.toml") || paths.includes("setup.py")) return { executable: "python", args: ["-m", "pip", "install", "--user", "-e", "."] };
  if (paths.includes("go.mod")) return { executable: "go", args: ["mod", "download"] };
  if (paths.includes("Cargo.toml")) return { executable: "cargo", args: ["fetch", ...(paths.includes("Cargo.lock") ? ["--locked"] : [])] };
  return null;
}
export function environmentFailure(output: string): "network" | "interpreter" | "missing_dependency" | "preparation" {
  if (/timed? out|connection|network|resolve|certificate|proxy|unreachable/iu.test(output)) return "network";
  if (/requires.python|unsupported.python|python.version|syntaxerror|engine.*unsupported|incompatible.*(?:version|interpreter)/iu.test(output)) return "interpreter";
  if (/modulenotfound|no module named|no matching distribution|cannot find module|not found|no such file/iu.test(output)) return "missing_dependency";
  return "preparation";
}
