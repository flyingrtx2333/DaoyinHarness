import type { JsonValue, ToolEvidence } from "@daoyin/harness-protocol";
import { Workspace } from "@daoyin/harness-workspace";
import type { ToolDefinition, ToolSuccess } from "./registry.js";

const objectSchema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function stringArgument(input: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw Object.assign(new Error(`${name} must be a ${allowEmpty ? "string" : "non-empty string"}.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value;
}

function optionalStringArgument(input: Record<string, unknown>, name: string, fallback: string): string {
  const value = input[name];
  if (value === undefined) {
    return fallback;
  }
  return stringArgument(input, name);
}

function success(toolName: string, summary: string, result: JsonValue, artifacts: string[] = []): ToolSuccess {
  const evidence: ToolEvidence = { schemaVersion: 1, toolName, result, artifacts, diagnostics: [] };
  return { ok: true, summary, evidence };
}

export function createWorkspaceTools(workspace: Workspace): ToolDefinition[] {
  return [
    {
      name: "list_files",
      description: "List regular files inside the selected workspace.",
      category: "workspace",
      mutating: false,
      inputSchema: objectSchema({ path: { type: "string" } }, []),
      async execute(input) {
        const relativePath = optionalStringArgument(input, "path", ".");
        const files = await workspace.listFiles(relativePath);
        return success("list_files", `Listed ${String(files.length)} files.`, { files });
      },
    },
    {
      name: "read_file",
      description: "Read one UTF-8 text file from the selected workspace.",
      category: "workspace",
      mutating: false,
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
      async execute(input) {
        const relativePath = stringArgument(input, "path");
        const content = await workspace.readText(relativePath);
        return success("read_file", `Read ${relativePath}.`, { path: relativePath, content }, [relativePath]);
      },
    },
    {
      name: "search_text",
      description: "Search for literal text in UTF-8 workspace files.",
      category: "workspace",
      mutating: false,
      inputSchema: objectSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
      async execute(input) {
        const query = stringArgument(input, "query");
        const relativePath = optionalStringArgument(input, "path", ".");
        const matches = await workspace.searchText(query, relativePath);
        return success("search_text", `Found ${String(matches.length)} matches.`, {
          matches: matches.map((match) => ({ path: match.path, line: match.line, text: match.text })),
        });
      },
    },
    {
      name: "write_file",
      description: "Create or atomically replace one UTF-8 workspace file.",
      category: "workspace",
      mutating: true,
      inputSchema: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      async execute(input) {
        const relativePath = stringArgument(input, "path");
        const content = stringArgument(input, "content", true);
        await workspace.writeText(relativePath, content);
        return success("write_file", `Wrote ${relativePath}.`, { path: relativePath, bytes: Buffer.byteLength(content, "utf8") }, [relativePath]);
      },
    },
    {
      name: "apply_patch",
      description: "Replace one exact, uniquely matching text block in a workspace file.",
      category: "workspace",
      mutating: true,
      inputSchema: objectSchema({ path: { type: "string" }, expected: { type: "string" }, replacement: { type: "string" } }, ["path", "expected", "replacement"]),
      async execute(input) {
        const relativePath = stringArgument(input, "path");
        const expected = stringArgument(input, "expected");
        const replacement = stringArgument(input, "replacement", true);
        await workspace.replaceText(relativePath, expected, replacement);
        return success("apply_patch", `Patched ${relativePath}.`, { path: relativePath }, [relativePath]);
      },
    },
  ];
}
