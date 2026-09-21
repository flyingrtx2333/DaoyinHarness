import { assertSha256Digest, assertWorkspacePath, type RuntimeSpec } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

const environmentKey = /^[A-Z_][A-Z0-9_]{0,79}$/u;
const secretKey = /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|API_KEY|ACCESS_KEY)/u;
const secretRef = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

export function assertRuntimeSpec(value: unknown): asserts value is RuntimeSpec {
  if (!value || typeof value !== "object") throw new ResourceError("RUNTIME_INVALID", "Runtime specification is invalid.", 422);
  const spec = value as Partial<RuntimeSpec>;
  if (!spec.image || typeof spec.image !== "object" || !spec.limits || typeof spec.limits !== "object" ||
      !["public", "none"].includes(spec.network ?? "") || !spec.environment || Array.isArray(spec.environment) ||
      !Array.isArray(spec.secretRefs) || spec.secretRefs.length > 32 || new Set(spec.secretRefs).size !== spec.secretRefs.length ||
      spec.secretRefs.some(item => typeof item !== "string" || !secretRef.test(item))) {
    throw new ResourceError("RUNTIME_INVALID", "Runtime specification is invalid.", 422);
  }
  if (spec.image.kind === "builtin") {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(spec.image.id)) throw new ResourceError("RUNTIME_IMAGE_INVALID", "Built-in runtime image id is invalid.", 422);
    try { assertSha256Digest(spec.image.digest); } catch { throw new ResourceError("RUNTIME_IMAGE_INVALID", "Built-in runtime image digest is invalid.", 422); }
  } else if (spec.image.kind === "dockerfile") {
    try {
      assertWorkspacePath(spec.image.path); assertWorkspacePath(spec.image.context === "." ? "workspace" : spec.image.context);
      if (spec.image.imageDigest !== undefined) assertSha256Digest(spec.image.imageDigest);
    } catch { throw new ResourceError("RUNTIME_IMAGE_INVALID", "Dockerfile runtime image is invalid.", 422); }
  } else throw new ResourceError("RUNTIME_IMAGE_INVALID", "Runtime image kind is invalid.", 422);
  for (const [key, item] of Object.entries(spec.environment)) {
    if (!environmentKey.test(key) || secretKey.test(key) || typeof item !== "string" || item.includes("\0") || item.length > 16_000) {
      throw new ResourceError("RUNTIME_ENV_INVALID", "Runtime environment contains a denied key or value.", 403);
    }
  }
  const limits = spec.limits;
  if (typeof limits.cpu !== "number" || !Number.isFinite(limits.cpu) || limits.cpu < 0.1 || limits.cpu > 2 ||
      !Number.isSafeInteger(limits.memoryMiB) || limits.memoryMiB < 128 || limits.memoryMiB > 4096 ||
      !Number.isSafeInteger(limits.pids) || limits.pids < 16 || limits.pids > 512 ||
      !Number.isSafeInteger(limits.diskMiB) || limits.diskMiB < 64 || limits.diskMiB > 8192 ||
      !Number.isSafeInteger(limits.timeoutSeconds) || limits.timeoutSeconds < 1 || limits.timeoutSeconds > 3600 ||
      !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1024 || limits.maxOutputBytes > 10_000_000) {
    throw new ResourceError("RUNTIME_LIMIT_INVALID", "Runtime resource limits are outside the operator policy.", 422);
  }
}
