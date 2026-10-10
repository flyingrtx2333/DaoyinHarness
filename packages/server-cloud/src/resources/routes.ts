import { Readable } from "node:stream";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CloudRepository } from "../repository.js";
import { CloudError } from "../repository.js";
import type { ResourceControlRequest } from "./contracts.js";
import { resourceCall } from "./tools.js";

const actionPattern = "^(?:resource_(?:list|attach|detach|media_(?:begin|chunk|commit|read|profile|analyze|supplement_approve)|campfire_(?:list|inspect|music|narrate|plan|render|status|supplement(?:_quote|_status)?))|workspace_(?:create|inspect|snapshot|restore)|file_(?:list|stat|read|search|write|patch|mkdir|move|remove)|git_(?:status|diff|log|branch|checkout|commit|export_patch)|process_(?:run|start|read|write|stop|list)|artifact_(?:create|read|list)|deployment_(?:create|status|rollback))$";

export function registerResourceRoutes(app: FastifyInstance, options: {
  repository: CloudRepository;
  identityFor(request: FastifyRequest): ExecutionIdentity;
  ensureActive(identity: ExecutionIdentity, signal?: AbortSignal): Promise<void>;
}): void {
  app.get<{ Params: { resourceId: string } }>("/api/v1/cloud/resources/media/:resourceId", {
    schema: { params: { type: "object", required: ["resourceId"], properties: { resourceId: { type: "string", pattern: "^res_[a-f0-9]{24}$" } } } },
  }, async (request, reply) => {
    const identity = options.identityFor(request);
    await options.ensureActive(identity);
    if (!identity.allowedTools.includes("resource_media_read")) throw new CloudError(403, "RESOURCE_TOOL_DENIED", "当前账号无法读取该素材。");
    const controller = new AbortController();
    let output: Readable | undefined;
    const closed = (): void => { controller.abort(); output?.destroy(new Error("Media request ended")); };
    reply.raw.once("close", closed);
    const timer = setTimeout(closed, 120_000);
    const cleanup = (): void => { clearTimeout(timer); reply.raw.removeListener("close", closed); };
    type Chunk = { contentBase64: string; nextOffset: number; size: number; done: boolean; mediaType: string };
    const read = async (offset: number): Promise<{ bytes: Buffer; value: Chunk }> => {
      const value = await resourceCall<Chunk>(identity, { action: "resource_media_read", resourceId: request.params.resourceId, offset }, controller.signal);
      if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > 134217728 ||
          !["video/mp4", "audio/mpeg", "audio/wav", "audio/mp4", "image/jpeg", "image/png", "image/webp", "text/plain"].includes(value.mediaType) || typeof value.contentBase64 !== "string")
        throw new CloudError(502, "MEDIA_RESPONSE_INVALID", "素材读取回执无效。");
      const bytes = Buffer.from(value.contentBase64, "base64");
      if (bytes.toString("base64") !== value.contentBase64 || bytes.length !== Math.min(262144, value.size - offset) || value.nextOffset !== offset + bytes.length || value.done !== (value.nextOffset === value.size))
        throw new CloudError(502, "MEDIA_RESPONSE_INVALID", "素材读取范围不完整。");
      return { bytes, value };
    };
    try {
      const first = await read(0); const { size, mediaType } = first.value;
      let start = 0; let end = size - 1;
      const range = request.headers["if-range"] === undefined ? request.headers.range : undefined;
      if (range !== undefined) {
        const match = range.length <= 100 ? /^bytes=(\d{1,9})?-(\d{1,9})?$/u.exec(range) : null;
        if (!match || !match[1] && !match[2]) { cleanup(); return reply.code(416).header("Content-Range", `bytes */${size}`).send(); }
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
        else { const suffix = Number(match[2]); start = Math.max(0, size - suffix); if (!suffix) start = size; }
        if (start >= size || end < start) { cleanup(); return reply.code(416).header("Content-Range", `bytes */${size}`).send(); }
        reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      reply.header("Accept-Ranges", "bytes").header("Content-Length", end - start + 1).type(mediaType);
      if (request.method === "HEAD") { cleanup(); return reply.send(Readable.from([])); }
      let validatedAt = Date.now();
      async function* stream(): AsyncGenerator<Buffer> {
        try {
          for (let offset = start; offset <= end;) {
            controller.signal.throwIfAborted();
            if (Date.now() - validatedAt >= 5000) { await options.ensureActive(identity, controller.signal); validatedAt = Date.now(); }
            const part = offset === 0 ? first : await read(offset);
            if (part.value.size !== size || part.value.mediaType !== mediaType) throw new CloudError(502, "MEDIA_RESPONSE_INVALID", "素材读取回执发生变化。");
            const bytes = part.bytes.subarray(0, Math.min(part.bytes.length, end - offset + 1));
            offset += bytes.length; yield bytes;
          }
        } finally { cleanup(); }
      }
      output = Readable.from(stream(), { objectMode: false, highWaterMark: 262144 });
      return reply.send(output);
    } catch (error) { cleanup(); throw error; }
  });
  app.post<{ Body: ResourceControlRequest }>("/api/v1/cloud/resources/control", {
    bodyLimit: 2_000_000,
    schema: { body: { type: "object", additionalProperties: true, required: ["action"], properties: {
      action: { type: "string", pattern: actionPattern }, sessionId: { type: "string", minLength: 1, maxLength: 160 },
      sourceRun: { type: "string", minLength: 1, maxLength: 160 }, requestId: { type: "string", minLength: 8, maxLength: 200 },
      resourceId: { type: "string", pattern: "^(?:res|wsp|snp|art|dep|prc)_[a-f0-9]{24}$" },
      workspaceId: { type: "string", pattern: "^wsp_[a-f0-9]{24}$" },
      snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" }, artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" },
      deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" }, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" },
      waitMs: { type: "integer", minimum: 0, maximum: 30000 },
    } } },
 }, async (request) => {
 const identity = options.identityFor(request);
 await options.ensureActive(identity);
 if (!identity.allowedTools.includes(request.body.action)) {
  throw new CloudError(403, "RESOURCE_TOOL_DENIED", "This resource operation is not enabled for the current account.");
 }
 if (request.body.sessionId) await options.repository.getSession(identity, request.body.sessionId);
    if (["resource_attach", "resource_detach", "workspace_create"].includes(request.body.action) && request.body.sessionId) {
      const runs = await options.repository.listRuns(identity, request.body.sessionId);
      if (runs.some((item) => ["running", "queued"].includes(item.status))) {
        throw new CloudError(409, "RESOURCE_SESSION_BUSY", "Wait for the current run to finish before changing attached resources.");
      }
    }
    return resourceCall<Record<string, unknown>>(identity, request.body);
  });
}
