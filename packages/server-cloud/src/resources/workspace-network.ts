import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { assertResourceId } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

interface DockerResult { exitCode: number; stdout: string; stderr: string }
type DockerCall = (args: string[], timeoutMs?: number) => Promise<DockerResult>;

const NETWORK_PREFIX = process.env.HARNESS_WORKSPACE_NETWORK_PREFIX ?? "harness-ws-";
const PROXY_URL = process.env.HARNESS_EGRESS_PROXY ?? process.env.HARNESS_EGRESS_PROXY_URL ?? "";
const EXPECTED_LABEL = "workspace-controlled";

function proxyContainer(): { name: string; port: number } {
  let value: URL;
  try { value = new URL(PROXY_URL); }
  catch { throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503); }
  const port = Number(value.port || 80);
  if (value.protocol !== "http:" || value.username || value.password || !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(value.hostname) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503);
  }
  return { name: value.hostname, port };
}

export function workspaceNetworkName(workspaceId: string): string {
  assertResourceId(workspaceId, "wsp");
  return `${NETWORK_PREFIX}${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
}

async function networkState(name: string, docker: DockerCall): Promise<Record<string, unknown> | null> {
  const inspected = await docker(["network", "inspect", name], 15_000);
  if (inspected.exitCode !== 0) return null;
  try {
    const values = JSON.parse(inspected.stdout) as unknown;
    return Array.isArray(values) && values.length === 1 && values[0] && typeof values[0] === "object"
      ? values[0] as Record<string, unknown> : null;
  } catch { return null; }
}

function assertNetworkState(state: Record<string, unknown> | null, workspaceId: string): void {
  const labels = state?.Labels;
  if (state?.Internal !== true || !labels || typeof labels !== "object" ||
      (labels as Record<string, unknown>)["daoyin.harness.egress"] !== EXPECTED_LABEL ||
      (labels as Record<string, unknown>)["daoyin.harness.workspace"] !== workspaceId) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "The workspace egress network is not isolated.", 503);
  }
}

export async function ensureWorkspaceEgress(workspaceId: string, docker: DockerCall): Promise<{
  networkName: string; proxyAddress: string; proxyPort: number;
}> {
  const networkName = workspaceNetworkName(workspaceId); const proxy = proxyContainer();
  let state = await networkState(networkName, docker);
  if (!state) {
    await docker(["network", "create", "--internal", "--label", `daoyin.harness.egress=${EXPECTED_LABEL}`,
      "--label", `daoyin.harness.workspace=${workspaceId}`, networkName], 20_000);
    state = await networkState(networkName, docker);
  }
  assertNetworkState(state, workspaceId);

  let inspected = await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", proxy.name], 10_000);
  if (inspected.exitCode !== 0) throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is unavailable.", 503);
  let networks: Record<string, { IPAddress?: unknown }>;
  try { networks = JSON.parse(inspected.stdout) as Record<string, { IPAddress?: unknown }>; }
  catch { throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress state is invalid.", 503); }
  if (!networks[networkName]) {
    const connected = await docker(["network", "connect", "--alias", proxy.name, networkName, proxy.name], 15_000);
    if (connected.exitCode !== 0 && !/already exists/iu.test(connected.stderr)) {
      throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress could not join the isolated workspace network.", 503);
    }
    inspected = await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", proxy.name], 10_000);
    try { networks = JSON.parse(inspected.stdout) as Record<string, { IPAddress?: unknown }>; }
    catch { throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress state is invalid.", 503); }
  }
  const address = networks[networkName]?.IPAddress;
  if (typeof address !== "string" || isIP(address) !== 4) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not attached to the isolated workspace network.", 503);
  }
  return { networkName, proxyAddress: address, proxyPort: proxy.port };
}

export async function isolateExistingContainer(containerName: string, workspaceId: string, legacyNetwork: string,
  docker: DockerCall): Promise<string> {
  const isolated = await ensureWorkspaceEgress(workspaceId, docker); const proxy = proxyContainer();
  const inspected = await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName], 10_000);
  if (inspected.exitCode !== 0) throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox could not be inspected.", 503);
  let networks: Record<string, unknown>;
  try { networks = JSON.parse(inspected.stdout) as Record<string, unknown>; }
  catch { throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox has invalid network state.", 503); }
  if (!networks[isolated.networkName]) {
    const connected = await docker(["network", "connect", isolated.networkName, containerName], 15_000);
    if (connected.exitCode !== 0) throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox could not enter its isolated workspace network.", 503);
  }
  const identity = await docker(["inspect", "--format", "{{.Id}}", containerName], 10_000);
  const containerId = identity.stdout.trim();
  if (identity.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox has no valid container identity.", 503);
  }
  const rootState = await docker(["info", "--format", "{{.DockerRootDir}}"], 10_000);
  const dockerRoot = path.resolve(rootState.stdout.trim());
  if (rootState.exitCode !== 0 || !path.isAbsolute(dockerRoot) || dockerRoot === path.parse(dockerRoot).root) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "The container storage root is unavailable.", 503);
  }
  const hostsPath = path.join(dockerRoot, "containers", containerId, "hosts");
  let hosts: string;
  try { hosts = await readFile(hostsPath, "utf8"); }
  catch { throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox host map is unavailable.", 503); }
  const retained = hosts.split(/\r?\n/u).filter((line) => !line.trim().split(/\s+/u).slice(1).includes(proxy.name));
  retained.push(`${isolated.proxyAddress}\t${proxy.name}`, "");
  await writeFile(hostsPath, retained.join("\n"), "utf8");
  if (legacyNetwork !== isolated.networkName && networks[legacyNetwork]) {
    const disconnected = await docker(["network", "disconnect", legacyNetwork, containerName], 15_000);
    if (disconnected.exitCode !== 0) throw new ResourceError("EGRESS_UNAVAILABLE", "A running sandbox could not leave the shared legacy network.", 503);
  }
  return isolated.networkName;
}
