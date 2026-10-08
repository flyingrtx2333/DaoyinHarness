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
const SUBNET_POOL = process.env.HARNESS_WORKSPACE_SUBNET_POOL;

interface AddressRange { start: number; end: number }
function ipv4Range(cidr: string): AddressRange {
  const parts = cidr.split("/");
  if (parts.length !== 2 || isIP(parts[0] ?? "") !== 4 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/u.test(parts[1] ?? "")) {
    throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Workspace subnet configuration could not be verified.", 503);
  }
  const address = parts[0]!.split(".").reduce((value, part) => value * 256 + Number(part), 0);
  const size = 2 ** (32 - Number(parts[1]));
  const start = Math.floor(address / size) * size;
  return { start, end: start + size - 1 };
}

function subnetPool(): { prefix: string; range: AddressRange } | undefined {
  if (SUBNET_POOL === undefined) return undefined;
  const match = /^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/u.exec(SUBNET_POOL);
  const first = Number(match?.[1]), second = Number(match?.[2]);
  if (!match || isIP(SUBNET_POOL.split("/")[0] ?? "") !== 4 ||
      !((first === 10) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168))) {
    throw new ResourceError("WORKSPACE_SUBNET_POOL_INVALID", "Workspace subnet pool must be a canonical private IPv4 /16.", 503);
  }
  return { prefix: `${first}.${second}`, range: ipv4Range(SUBNET_POOL) };
}

async function occupiedRanges(docker: DockerCall): Promise<AddressRange[]> {
  const listed = await docker(["network", "ls", "--format", "{{.ID}}"], 15_000);
  if (listed.exitCode !== 0) throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network inventory is unavailable.", 503);
  const ids = listed.stdout.trim().split(/\s+/u).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{12,64}$/u.test(id))) {
    throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network inventory is invalid.", 503);
  }
  const ranges: AddressRange[] = [];
  for (let offset = 0; offset < ids.length; offset += 64) {
    const inspected = await docker(["network", "inspect", "--format", "{{json .IPAM.Config}}", ...ids.slice(offset, offset + 64)], 15_000);
    if (inspected.exitCode !== 0) throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network subnets could not be inspected.", 503);
    const lines = inspected.stdout.trim().split(/\r?\n/u);
    if (lines.length !== Math.min(64, ids.length - offset)) {
      throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network subnet inventory is incomplete.", 503);
    }
    for (const line of lines) {
      let entries: unknown;
      try { entries = JSON.parse(line) as unknown; }
      catch { throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network subnet inventory is invalid.", 503); }
      if (entries === null) continue; // Host and none networks have no IPAM allocation.
      if (!Array.isArray(entries)) throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network subnet inventory is invalid.", 503);
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || !("Subnet" in entry) || typeof entry.Subnet !== "string") {
          throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "Docker network subnet inventory is invalid.", 503);
        }
        if (isIP(entry.Subnet.split("/")[0] ?? "") === 6) continue;
        ranges.push(ipv4Range(entry.Subnet));
      }
    }
  }
  return ranges;
}

async function createWorkspaceNetwork(name: string, workspaceId: string, docker: DockerCall): Promise<void> {
  const pool = subnetPool();
  const firstSlot = createHash("sha256").update(workspaceId).digest()[0]!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = ["network", "create", "--internal", "--label", `daoyin.harness.egress=${EXPECTED_LABEL}`,
      "--label", `daoyin.harness.workspace=${workspaceId}`];
    if (pool) {
      const occupied = await occupiedRanges(docker);
      let subnet: string | undefined;
      for (let offset = 0; offset < 256; offset++) {
        const slot = (firstSlot + offset) % 256;
        const start = pool.range.start + slot * 256;
        if (!occupied.some(range => start <= range.end && start + 255 >= range.start)) {
          subnet = `${pool.prefix}.${slot}.0/24`; break;
        }
      }
      if (!subnet) {
        const concurrent = await networkState(name, docker);
        if (concurrent) { assertNetworkState(concurrent, workspaceId); return; }
        throw new ResourceError("WORKSPACE_SUBNET_POOL_EXHAUSTED", "The configured workspace subnet pool has no available /24 network.", 503);
      }
      args.push("--subnet", subnet);
    }
    const created = await docker([...args, name], 20_000);
    // Inspection, including isolation and ownership, is authoritative even if
    // a concurrent same-workspace request created the network first.
    const state = await networkState(name, docker);
    if (state) { assertNetworkState(state, workspaceId); return; }
    if (created.exitCode === 0) throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "The created workspace network could not be verified.", 503);
    if (pool && /pool overlaps|invalid pool request.*overlap/iu.test(created.stderr) && attempt < 2) continue;
    if (/all predefined address pools have been fully subnetted|could not find an available.*address pool/iu.test(created.stderr)) {
      throw new ResourceError("WORKSPACE_SUBNET_POOL_EXHAUSTED", "Docker's default subnet pools are exhausted; configure a dedicated workspace subnet pool.", 503);
    }
    throw new ResourceError("WORKSPACE_NETWORK_CREATE_FAILED", "An isolated workspace network could not be created.", 503);
  }
}

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
  if (inspected.exitCode !== 0) {
    if (/no such network|network .* not found/iu.test(inspected.stderr)) return null;
    throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "The workspace network could not be inspected.", 503);
  }
  try {
    const values = JSON.parse(inspected.stdout) as unknown;
    if (Array.isArray(values) && values.length === 1 && values[0] && typeof values[0] === "object") return values[0] as Record<string, unknown>;
  } catch { /* Invalid inspection is a failure, not an absent network. */ }
  throw new ResourceError("EGRESS_NETWORK_INSPECTION_FAILED", "The workspace network inspection is invalid.", 503);
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
    await createWorkspaceNetwork(networkName, workspaceId, docker);
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
