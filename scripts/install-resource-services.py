#!/usr/bin/env python3
"""Prepare or activate the generic resource services on the authoritative Linux server.

Preparation is reversible and never enables admission. Activation requires a fully configured
environment, gVisor, BuildKit CNI and an already built immutable release.
"""

import argparse
import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import secrets
import shutil
import subprocess
import sys

BASE = pathlib.Path("/opt/daoyin-resources")
CONFIG = pathlib.Path("/etc/daoyin-resources")
STATE = pathlib.Path("/var/lib/daoyin-resources")
RUN = pathlib.Path("/run")
SYSTEMD = pathlib.Path("/etc/systemd/system")
NODE = pathlib.Path("/opt/daoyin-harness/node/bin/node")


def command(args: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, capture_output=True, text=True, env=env)


def ensure_group(name: str) -> int:
    try:
        return grp.getgrnam(name).gr_gid
    except KeyError:
        command(["groupadd", "--system", name])
        return grp.getgrnam(name).gr_gid


def ensure_user(name: str, group: str, home: str) -> pwd.struct_passwd:
    try:
        return pwd.getpwnam(name)
    except KeyError:
        command(["useradd", "--system", "--gid", group, "--home-dir", home, "--shell", "/sbin/nologin", name])
        return pwd.getpwnam(name)


def env_file(path: pathlib.Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            result[key] = value
    return result


def write_env(path: pathlib.Path, values: dict[str, str], uid: int, gid: int) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in sorted(values.items())), encoding="utf-8")
    os.chmod(path, 0o640)
    os.chown(path, uid, gid)


def unit(name: str, body: str) -> None:
    target = SYSTEMD / name
    target.write_text(body.strip() + "\n", encoding="utf-8")
    os.chmod(target, 0o644)


def require_release(value: str) -> pathlib.Path:
    release = pathlib.Path(value).resolve()
    if not release.is_relative_to(BASE / "releases") or not (release / "release.json").is_file():
        raise RuntimeError("Release must be an immutable /opt/daoyin-resources/releases/<revision> artifact.")
    manifest = json.loads((release / "release.json").read_text(encoding="utf-8"))
    required = {"service.mjs", "executor.mjs", "builder.mjs", "egress.mjs", "deployment.mjs", "migrate.mjs", "schema.sql"}
    if manifest.get("sourceState") != "committed-resource-sources" or not required.issubset(manifest.get("files", {})):
        raise RuntimeError("Resource release is incomplete or was built from uncommitted resource sources.")
    revision = manifest.get("sourceRevision", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or release.name != revision:
        raise RuntimeError("Resource release directory must match its exact source revision.")
    for name, expected in manifest["files"].items():
        target = release / name
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Resource release integrity check failed: {name}")
    return release


def require_activation(values: dict[str, str]) -> None:
    required = ["HARNESS_RESOURCES_DATABASE_URL", "HARNESS_CONTENT_STORE_ROOT", "HARNESS_RUNTIME_IMAGES", "HARNESS_GVISOR_RUNTIME",
                "HARNESS_DEFAULT_RUNTIME", "HARNESS_SANDBOX_PROBE", "HARNESS_EGRESS_HMAC_SECRET"]
    missing = [name for name in required if not values.get(name)]
    if missing:
        raise RuntimeError("Resource environment is incomplete: " + ", ".join(missing))
    if len(values["HARNESS_EGRESS_HMAC_SECRET"]) < 32:
        raise RuntimeError("Egress HMAC secret is too short.")
    if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", values.get("HARNESS_EGRESS_NODE_IMAGE", "")):
        raise RuntimeError("Trusted Node egress image must be pinned by sha256 digest.")
    catalog = json.loads(values["HARNESS_RUNTIME_IMAGES"])
    if not catalog or any(not item.get("image", "").endswith("@" + item.get("digest", "")) for item in catalog.values()):
        raise RuntimeError("Every runtime image must be pinned by matching sha256 digest.")
    info = json.loads(command(["docker", "info", "--format", "{{json .Runtimes}}"] ).stdout)
    if values.get("HARNESS_GVISOR_RUNTIME", "runsc") not in info:
        raise RuntimeError("Configured gVisor runtime is unavailable.")
    for item in catalog.values():
        command(["docker", "image", "inspect", item["image"]])
    command(["docker", "image", "inspect", values["HARNESS_EGRESS_NODE_IMAGE"]])
    buildkit_files = [pathlib.Path("/usr/bin/buildctl"), pathlib.Path("/usr/bin/buildkitd"),
                      *(pathlib.Path("/opt/cni/bin") / name for name in
                        ["bridge", "firewall", "host-local", "loopback"])]
    if any(not item.is_file() for item in buildkit_files):
        raise RuntimeError("BuildKit binaries and isolated bridge CNI plugins are required.")


def prepare(release: pathlib.Path) -> dict[str, object]:
    if os.geteuid() != 0 or sys.platform != "linux":
        raise RuntimeError("Run on the authoritative Linux server as root.")
    resource_gid = ensure_group("daoyin-resources")
    executor_gid = ensure_group("daoyin-resource-executor")
    builder_gid = ensure_group("daoyin-resource-builder")
    agent_gid = grp.getgrnam("daoyin-agent").gr_gid
    grp.getgrnam("daoyin-projects")
    account = ensure_user("daoyin-resources", "daoyin-resources", str(STATE))
    builder = ensure_user("daoyin-resource-builder", "daoyin-resource-builder", str(STATE / "builds"))
    command(["usermod", "-a", "-G", "daoyin-agent,daoyin-resource-executor,daoyin-resource-builder,daoyin-projects", "daoyin-resources"])
    command(["usermod", "-a", "-G", "daoyin-resources", "daoyin-agent"])
    runtimes = json.loads(command(["docker", "info", "--format", "{{json .Runtimes}}"] ).stdout)
    detected_gvisor = next((name for name in ("harness-runsc", "runsc") if name in runtimes), "")

    CONFIG.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(CONFIG, 0, resource_gid)
    for directory, mode, uid, gid in [
        (STATE, 0o710, 0, resource_gid), (STATE / "content", 0o700, account.pw_uid, resource_gid),
        (STATE / "workspaces", 0o711, 0, executor_gid), (STATE / "disks", 0o700, 0, executor_gid),
        (STATE / "builds", 0o700, builder.pw_uid, builder_gid), (STATE / "deployments", 0o700, 0, executor_gid),
    ]:
        directory.mkdir(mode=mode, parents=True, exist_ok=True)
        os.chmod(directory, mode)
        os.chown(directory, uid, gid)

    values = env_file(CONFIG / "service.env")
    if not values:
        legacy = env_file(pathlib.Path("/etc/daoyin-projects/service.env"))
        values = {
            "HARNESS_RESOURCES_DATABASE_URL": legacy.get("HARNESS_PROJECTS_DATABASE_URL", ""),
            "HARNESS_CONTENT_STORE_ROOT": str(STATE / "content"),
            "HARNESS_WORKSPACE_ROOT": str(STATE / "workspaces"),
            "HARNESS_WORKSPACE_DISK_ROOT": str(STATE / "disks"),
            "HARNESS_BUILD_OUTPUT_ROOT": str(STATE / "builds"),
            "HARNESS_DEPLOYMENT_ROOT": str(STATE / "deployments"),
            "HARNESS_RESOURCES_ALLOWED_USERS": "",
            "HARNESS_RESOURCES_ENABLED": "0",
            "HARNESS_DEPLOYMENT_EXECUTOR_ENABLED": "0",
            "HARNESS_GENERAL_RESOURCES_MODE": "off",
            "HARNESS_RESOURCE_GID": str(agent_gid),
            "HARNESS_CONTENT_STORE_GID": str(resource_gid),
            "HARNESS_GVISOR_RUNTIME": detected_gvisor,
            "HARNESS_EGRESS_NETWORK": "harness-public-egress",
            "HARNESS_EGRESS_PROXY": "http://daoyin-resource-egress:3128",
            "HARNESS_EGRESS_PORT": "3128",
            "HARNESS_EGRESS_HMAC_SECRET": secrets.token_urlsafe(48),
            "HARNESS_EGRESS_DENIED_HOSTS": "metadata.google.internal,instance-data,daoyintech.internal",
            "HARNESS_EGRESS_NODE_IMAGE": "",
            "HARNESS_DEPLOYMENT_ROUTER_HOST": "127.0.0.1",
            "HARNESS_DEPLOYMENT_ROUTER_PORT": "4712",
            "HARNESS_DEPLOYMENT_DOMAIN_SUFFIX": ".demo.daoyintech.com",
            "HARNESS_MAX_ONLINE_DEPLOYMENTS": "2",
            "HARNESS_RUNTIME_IMAGES": "",
            "HARNESS_DEFAULT_RUNTIME": "",
            "HARNESS_BUILDER_BOOTSTRAP_RUNTIME": "",
            "HARNESS_SANDBOX_PROBE": "",
            "HARNESS_SECRET_RESOLVER_URL": legacy.get("HARNESS_PROJECTS_AI_ORIGIN", "http://127.0.0.1:6087").rstrip("/") + "/api/internal/ai/harness/secrets",
            "HARNESS_SECRET_RESOLVER_TOKEN": legacy.get("HARNESS_PROJECTS_AI_TOKEN", ""),
        }
    values["HARNESS_RESOURCE_GID"] = str(agent_gid)
    values["HARNESS_CONTENT_STORE_GID"] = str(resource_gid)
    write_env(CONFIG / "service.env", values, 0, resource_gid)

    dependencies = release / "node_modules"
    if not dependencies.exists():
        dependencies.symlink_to(pathlib.Path("/opt/daoyin-harness/current/node_modules"), target_is_directory=True)

    unit("daoyin-resource-buildkit.service", f"""
[Unit]
Description=Daoyin isolated OCI BuildKit
After=network-online.target
[Service]
Type=simple
ExecStart=/usr/bin/buildkitd --addr unix:///run/daoyin-buildkit/buildkitd.sock --group daoyin-resource-builder --root {STATE / 'buildkit'} --oci-worker=true --containerd-worker=false --oci-worker-net=bridge
Restart=on-failure
RestartSec=5
TasksMax=512
MemoryMax=2G
UMask=0027
[Install]
WantedBy=multi-user.target
""")
    current = BASE / "current"
    unit("daoyin-resource-executor.service", f"""
[Unit]
Description=Daoyin gVisor workspace executor
After=docker.service daoyin-resource-egress.service
Requires=docker.service daoyin-resource-egress.service
[Service]
Type=simple
User=root
EnvironmentFile={CONFIG / 'service.env'}
ExecStartPre=+/usr/bin/install -d -m 0750 -o root -g daoyin-agent /run/daoyin-resource-executor
ExecStart={NODE} {current / 'executor.mjs'}
Restart=on-failure
RestartSec=5
TasksMax=512
MemoryMax=512M
UMask=0027
[Install]
WantedBy=multi-user.target
""")
    unit("daoyin-resource-builder.service", f"""
[Unit]
Description=Daoyin isolated OCI build client
After=daoyin-resource-buildkit.service
Requires=daoyin-resource-buildkit.service
[Service]
Type=simple
User=daoyin-resource-builder
Group=daoyin-resource-builder
SupplementaryGroups=daoyin-agent
EnvironmentFile={CONFIG / 'service.env'}
Environment=HARNESS_BUILDKIT_ADDRESS=unix:///run/daoyin-buildkit/buildkitd.sock
RuntimeDirectory=daoyin-resource-builder
RuntimeDirectoryMode=0750
ExecStartPre=+/usr/bin/install -d -m 0750 -o daoyin-resource-builder -g daoyin-agent /run/daoyin-resource-builder
ExecStart={NODE} {current / 'builder.mjs'}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={STATE / 'builds'} /run/daoyin-resource-builder
ReadOnlyPaths={STATE / 'workspaces'}
UMask=0027
[Install]
WantedBy=multi-user.target
""")
    unit("daoyin-resource-deployer.service", f"""
[Unit]
Description=Daoyin immutable deployment router
After=docker.service daoyin-resource-egress.service
Requires=docker.service daoyin-resource-egress.service
[Service]
Type=simple
User=root
EnvironmentFile={CONFIG / 'service.env'}
ExecStartPre=+/usr/bin/install -d -m 0750 -o root -g daoyin-agent /run/daoyin-resource-deployer
ExecStart={NODE} {current / 'deployment.mjs'}
Restart=on-failure
RestartSec=5
TasksMax=256
MemoryMax=512M
UMask=0027
[Install]
WantedBy=multi-user.target
""")
    unit("daoyin-resources.service", f"""
[Unit]
Description=Daoyin generic resource service
After=daoyin-resource-executor.service daoyin-resource-builder.service daoyin-resource-deployer.service postgresql.service
Requires=daoyin-resource-executor.service daoyin-resource-builder.service daoyin-resource-deployer.service
[Service]
Type=simple
User=daoyin-resources
Group=daoyin-resources
SupplementaryGroups=daoyin-agent daoyin-resource-executor daoyin-resource-builder daoyin-projects
EnvironmentFile={CONFIG / 'service.env'}
RuntimeDirectory=daoyin-resources
RuntimeDirectoryMode=0750
ExecStartPre=+/usr/bin/install -d -m 0750 -o daoyin-resources -g daoyin-agent /run/daoyin-resources
ExecStart={NODE} {current / 'service.mjs'}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={STATE / 'content'} /run/daoyin-resources
UMask=0027
[Install]
WantedBy=multi-user.target
""")

    # The trusted proxy is the only container with both the internal workspace network and an uplink.
    dependency_source = (release / "node_modules").resolve()
    egress_image = values.get("HARNESS_EGRESS_NODE_IMAGE") or "REPLACE_WITH_VERIFIED_DIGEST"
    egress_script = CONFIG / "run-egress.sh"
    egress_script.write_text(f"""#!/bin/sh
set -eu
/usr/bin/docker rm -f daoyin-resource-egress >/dev/null 2>&1 || true
/usr/bin/docker run --rm --name daoyin-resource-egress --network bridge \\
  --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m --cpus 0.5 \\
  --env-file {CONFIG / 'service.env'} --mount type=bind,src={current},dst=/opt/service,readonly \\
  --mount type=bind,src={dependency_source},dst=/opt/service/node_modules,readonly \\
  --mount type=bind,src=/run/daoyin-projects-db,dst=/run/daoyin-projects-db \\
  --entrypoint /usr/local/bin/node {egress_image} /opt/service/egress.mjs &
pid=$!
trap '/usr/bin/docker rm -f daoyin-resource-egress >/dev/null 2>&1 || true' EXIT INT TERM
for i in $(seq 1 30); do /usr/bin/docker inspect daoyin-resource-egress >/dev/null 2>&1 && break; sleep 1; done
/usr/bin/docker network connect --alias daoyin-resource-egress harness-public-egress daoyin-resource-egress
wait "$pid"
""", encoding="utf-8")
    os.chmod(egress_script, 0o750)
    unit("daoyin-resource-egress.service", f"""
[Unit]
Description=Daoyin audited public egress boundary
After=docker.service
Requires=docker.service
[Service]
Type=simple
ExecStart={egress_script}
Restart=on-failure
RestartSec=5
TasksMax=192
MemoryMax=320M
[Install]
WantedBy=multi-user.target
""")

    next_link = BASE / "current.next"
    if next_link.is_symlink():
        next_link.unlink()
    next_link.symlink_to(release, target_is_directory=True)
    next_link.replace(current)
    command(["systemctl", "daemon-reload"])
    return {"prepared": True, "release": str(release), "admission": False, "environment": str(CONFIG / "service.env")}


def activate(values: dict[str, str]) -> dict[str, object]:
    require_activation(values)
    # Never create a fallback non-internal network.
    existing = command(["docker", "network", "inspect", "harness-public-egress"], check=False)
    if existing.returncode != 0:
        command(["docker", "network", "create", "--internal", "--label", "daoyin.harness.egress=controlled-public", "harness-public-egress"])
    inspected = command(["docker", "network", "inspect", "--format", "{{.Internal}} {{index .Labels \"daoyin.harness.egress\"}}", "harness-public-egress"]).stdout.strip()
    if inspected != "true controlled-public":
        raise RuntimeError("Workspace egress network is not internal and controlled.")
    if "REPLACE_WITH_VERIFIED_DIGEST" in (CONFIG / "run-egress.sh").read_text(encoding="utf-8"):
        raise RuntimeError("Pin the trusted Node egress image by verified sha256 digest before activation.")
    command(["systemctl", "enable", "--now", "daoyin-resource-buildkit.service", "daoyin-resource-egress.service",
             "daoyin-resource-executor.service", "daoyin-resource-builder.service", "daoyin-resource-deployer.service"])
    command([str(NODE), str(BASE / "current" / "migrate.mjs"), "--schema"], check=True,
            env={**os.environ, **values})
    command(["systemctl", "enable", "--now", "daoyin-resources.service"])
    return {"activated": True, "admission": values.get("HARNESS_RESOURCES_ENABLED") == "1",
            "deployment": values.get("HARNESS_DEPLOYMENT_EXECUTOR_ENABLED") == "1"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("release")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    if args.prepare == args.activate:
        raise RuntimeError("Choose exactly one of --prepare or --activate.")
    release = require_release(args.release)
    result = prepare(release) if args.prepare else activate(env_file(CONFIG / "service.env"))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
