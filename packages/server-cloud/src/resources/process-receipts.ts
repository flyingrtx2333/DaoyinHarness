import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertResourceId } from "@daoyin/harness-contracts";

export interface ProcessReceipt {
  processId: string; workspaceId: string; state: string; exitCode: number | null;
  output: string; cursor: number; truncated: boolean; digest: string;
  startedAt: string; finishedAt: string | null; timeoutAt: string;
}
export class ProcessReceiptStore {
  public constructor(private readonly root: string) {}
  private file(workspaceId: string, processId: string): string {
    assertResourceId(workspaceId, "wsp"); assertResourceId(processId, "prc");
    return path.join(this.root, workspaceId, `${processId}.json`);
  }
  public async read(workspaceId: string, processId: string): Promise<ProcessReceipt | null> {
    try { return JSON.parse(await readFile(this.file(workspaceId, processId), "utf8")) as ProcessReceipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  public async save(input: Omit<ProcessReceipt, "digest">): Promise<ProcessReceipt> {
    const file = this.file(input.workspaceId, input.processId);
    const previous = await this.read(input.workspaceId, input.processId);
    if (previous) return previous;
    const receipt = { ...input, digest: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}` };
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.pending`;
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, file);
    return receipt;
  }

}
export function receiptPage(receipt: ProcessReceipt, cursor = 0): Record<string, unknown> {
  const bytes = Buffer.from(receipt.output); const start = Math.min(Math.max(0, cursor), bytes.byteLength);
  const end = Math.min(bytes.byteLength, start + 1_000_000);
  return { ...receipt, output: bytes.subarray(start, end).toString("utf8"), cursor: end,
    truncated: receipt.truncated || end < bytes.byteLength, terminalReceipt: true };
}
