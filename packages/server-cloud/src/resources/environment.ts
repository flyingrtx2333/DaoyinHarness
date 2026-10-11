import { createHash } from "node:crypto";

// Declaration files are read as data. No imports, evaluation or project hooks
// run during inspection. Installation is a separate explicit preparation action.
export const PROJECT_DECLARATIONS = ["package.json", ".nvmrc", ".node-version", ".python-version", ".tool-versions",
  "pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py", "Makefile", "CONTRIBUTING.md", "CONTRIBUTING.rst",
  "requirements-dev.txt", "requirements-test.txt", "requirements/testing.txt", "requirements/dev.txt",
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "setup.py", "requirements.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "Dockerfile"] as const;
// Documents and test selection remain useful inspection evidence, but editing
// them must not discard an already installed dependency environment.
const DEPENDENCY_DECLARATIONS = new Set<string>(["package.json", ".nvmrc", ".node-version", ".python-version", ".tool-versions",
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "setup.cfg", "setup.py",
  "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "requirements/testing.txt", "requirements/dev.txt",
  "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]);
export const isDependencyDeclaration = (name: string): boolean => DEPENDENCY_DECLARATIONS.has(name);
export function environmentVersionProbes(declarations: readonly { path: string; content?: string; truncated?: boolean }[], capabilities: readonly string[]): string[] {
  const paths = new Set(declarations.map(item => item.path));
  const has = (...names: string[]): boolean => names.some(name => paths.has(name));
  const capable = (family: string): boolean => capabilities.some(value => new RegExp(`^${family}(?:$|[-:@\\d])`, "iu").test(value));
  const selected = new Set<string>();
  if (has("package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version") || capable("node")) {
    selected.add("node"); selected.add("npm");
    if (has("pnpm-lock.yaml")) selected.add("pnpm");
    if (has("yarn.lock")) selected.add("yarn");
    const declaration = declarations.find(item => item.path === "package.json");
    if (declaration?.content && !declaration.truncated) {
      try {
        const manager: unknown = (JSON.parse(declaration.content) as { packageManager?: unknown }).packageManager;
        if (typeof manager === "string" && /^pnpm(?:@|$)/u.test(manager)) selected.add("pnpm");
        if (typeof manager === "string" && /^yarn(?:@|$)/u.test(manager)) selected.add("yarn");
      } catch { /* Invalid declaration stays uncertain; never evaluate it. */ }
    }
  }
  if (has("pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "requirements/testing.txt", "requirements/dev.txt", "Pipfile", ".python-version") || capable("python")) {
    selected.add("python3"); selected.add("python"); selected.add("pip");
    if (has("uv.lock")) selected.add("uv");
    if (has("poetry.lock")) selected.add("poetry");
    if (has("Pipfile", "Pipfile.lock")) selected.add("pipenv");
  }
  if (has("go.mod") || capable("go")) selected.add("go");
  if (has("Cargo.toml", "rust-toolchain.toml") || capable("rust")) { selected.add("rustc"); selected.add("cargo"); }
  return [...selected];
}
export interface RuntimeCatalogEntry { digest?: unknown; image?: unknown; version?: unknown; capabilities?: unknown }
export function trustedRuntimeCatalog(catalog: Record<string, RuntimeCatalogEntry>): Array<{ id: string; digest: string; image: string | null; version: string | null; capabilities: string[] }> {
  return Object.entries(catalog).flatMap(([id, entry]) => typeof entry.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(entry.digest)
    ? [{ id, digest: entry.digest, image: typeof entry.image === "string" && entry.image.endsWith(`@${entry.digest}`) ? entry.image : null,
      version: typeof entry.version === "string" ? entry.version.slice(0, 160) : null,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.filter((value): value is string => typeof value === "string").slice(0, 32) : [] }] : []);
}

interface RuntimeHint { family: "python" | "node"; source: string; kind: "pin" | "constraint" | "published_support"; value: string }
/** Bounded declaration text is evidence, never executed configuration or an inferred upper bound. */
export function environmentRuntimeAssessment(
  declarations: readonly { path: string; content?: string; truncated?: boolean }[],
  interpreters: readonly { executable: string; available?: boolean; output?: string; truncated?: boolean }[],
): { hints: RuntimeHint[]; observations: Array<{ family: "python" | "node"; actualVersion: string | null; status: "pin_matches" | "pin_mismatch" | "declaration_conflict" | "unconfirmed" | "unknown" }>; incompleteSources: string[] } {
  const hints: RuntimeHint[] = [];
  const add = (family: RuntimeHint["family"], source: string, kind: RuntimeHint["kind"], value: string): void => {
    if (hints.length < 64 && value.length <= 160 && !hints.some(item => item.family === family && item.source === source && item.kind === kind && item.value === value)) hints.push({ family, source, kind, value });
  };
  const incompleteSources: string[] = [];
  for (const item of declarations) {
    if (item.truncated || item.content === undefined || item.content.length > 32768) { incompleteSources.push(item.path); continue; }
    const body = item.content;
    if ([".python-version", ".node-version", ".nvmrc"].includes(item.path)) {
      const value = body.trim().replace(/^v/u, "");
      if (/^\d+(?:\.\d+){0,2}$/u.test(value)) add(item.path === ".python-version" ? "python" : "node", item.path, "pin", value);
      else incompleteSources.push(item.path);
    }
    if (item.path === ".tool-versions") {
      for (const match of body.matchAll(/^(python|nodejs)\s+(\d+(?:\.\d+){0,2})\s*$/gmu)) add(match[1] === "python" ? "python" : "node", item.path, "pin", match[2]!);
      if (body.split(/\r?\n/u).some(line => /^(python|nodejs)\s/u.test(line) && !/^(python|nodejs)\s+\d+(?:\.\d+){0,2}\s*$/u.test(line))) incompleteSources.push(item.path);
    }
    if (item.path === "package.json") {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const engines = (parsed as { engines?: unknown }).engines;
          if (engines && typeof engines === "object" && !Array.isArray(engines)) {
            const node = (engines as { node?: unknown }).node;
            if (typeof node === "string") add("node", item.path, "constraint", node);
          }
        }
      } catch { incompleteSources.push(item.path); }
    }
    if (["pyproject.toml", "setup.cfg", "setup.py"].includes(item.path)) {
      // These are literal metadata hints, not a TOML/Python evaluator. Expressions
      // and dynamic values remain unknown; no regex-derived constraint is executed.
      for (const match of body.matchAll(/(?:requires-python|python_requires)\s*=\s*["']([^"'\r\n]{1,160})["']/gu)) add("python", item.path, "constraint", match[1]!);
      if (item.path === "setup.cfg") {
        for (const match of body.matchAll(/^\s*python_requires\s*=\s*([<>=!~\d][^#;\r\n]{0,159})$/gmu)) add("python", item.path, "constraint", match[1]!.trim());
      }
      for (const match of body.matchAll(/Programming Language :: Python :: (\d+\.\d+(?:\.\d+)?)/gu)) add("python", item.path, "published_support", match[1]!);
    }
  }
  const families = new Set(hints.map(item => item.family));
  if (interpreters.some(item => item.executable === "python" || item.executable === "python3")) families.add("python");
  if (interpreters.some(item => item.executable === "node")) families.add("node");
  const observations = [...families].map(family => {
    const versions = interpreters.filter(item => (family === "python" ? ["python", "python3"].includes(item.executable) : item.executable === "node") && item.available && !item.truncated)
      .map(item => (family === "python" ? /^Python\s+(\d+\.\d+\.\d+)/u : /^v(\d+\.\d+\.\d+)/u).exec(item.output?.trim() ?? "")?.[1])
      .filter((value): value is string => value !== undefined);
    const actualVersion = versions.length && new Set(versions).size === 1 ? versions[0]! : null;
    const pins = hints.filter(item => item.family === family && item.kind === "pin");
    const extendsPin = (version: string, pin: string): boolean => version === pin || version.startsWith(pin + ".");
    const conflicting = pins.some(pin => pins.some(other => !extendsPin(pin.value, other.value) && !extendsPin(other.value, pin.value)));
    const incompletePins = incompleteSources.some(source => source === ".tool-versions" ||
      (family === "python" ? source === ".python-version" : [".node-version", ".nvmrc"].includes(source)));
    const status: "pin_matches" | "pin_mismatch" | "declaration_conflict" | "unconfirmed" | "unknown" = conflicting ? "declaration_conflict"
      : actualVersion === null ? "unknown" : pins.some(pin => !extendsPin(actualVersion, pin.value)) ? "pin_mismatch"
        : !pins.length || incompletePins ? "unconfirmed" : "pin_matches";
    return { family, actualVersion, status };
  });
  return { hints, observations, incompleteSources: [...new Set(incompleteSources)] };
}
export function environmentCacheKey(imageDigest: string, declarations: Array<{ path: string; digest: string }>, environment: Readonly<Record<string, string>> = {}): string {
  const dependencies = declarations.filter(item => DEPENDENCY_DECLARATIONS.has(item.path)).map(({ path, digest }) => ({ path, digest }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const options = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([imageDigest, dependencies, options])).digest("hex");
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
