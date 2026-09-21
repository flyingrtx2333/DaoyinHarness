import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CloudRepository } from "../repository.js";
import { CloudError } from "../repository.js";
import type { ResourceControlRequest } from "./contracts.js";
import { resourceCall } from "./tools.js";

const actionPattern = "^(?:resource_(?:list|attach|detach)|workspace_(?:create|inspect|snapshot|restore)|file_(?:list|stat|read|search|write|patch|mkdir|move|remove)|git_(?:status|diff|log|branch|checkout|commit|export_patch)|process_(?:run|start|read|write|stop|list)|artifact_(?:create|read|list)|deployment_(?:create|status|rollback))$";

export function registerResourceRoutes(app: FastifyInstance, options: {
  repository: CloudRepository;
  identityFor(request: FastifyRequest): ExecutionIdentity;
  ensureActive(identity: ExecutionIdentity, signal?: AbortSignal): Promise<void>;
}): void {
  app.post<{ Body: ResourceControlRequest }>("/api/v1/cloud/resources/control", {
    bodyLimit: 2_000_000,
    schema: { body: { type: "object", additionalProperties: true, required: ["action"], properties: {
      action: { type: "string", pattern: actionPattern }, sessionId: { type: "string", minLength: 1, maxLength: 160 },
      sourceRun: { type: "string", minLength: 1, maxLength: 160 }, requestId: { type: "string", minLength: 8, maxLength: 200 },
      resourceId: { type: "string", pattern: "^(?:res|wsp|snp|art|dep|prc)_[a-f0-9]{24}$" },
      workspaceId: { type: "string", pattern: "^wsp_[a-f0-9]{24}$" },
      snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" }, artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" },
      deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" }, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" },
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
