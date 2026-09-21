#!/usr/bin/env python3
"""Atomically switch the managed demo domain from the legacy project gateway to generic deployments."""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

BACKUP_ROOT = pathlib.Path("/var/backups/daoyin-agent")
PROJECT_ENV = pathlib.Path("/etc/daoyin-projects/service.env")
DROP_IN = pathlib.Path("/etc/systemd/system/daoyin-projects.service.d/20-broker-only.conf")
PROJECT_UNIT = pathlib.Path("/etc/systemd/system/daoyin-projects.service")
NGINX = pathlib.Path("/www/server/nginx/sbin/nginx")


def command(args: list[str]) -> None:
    subprocess.run(args, check=True)


def replace_env(path: pathlib.Path, replacements: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    seen: set[str] = set()
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in replacements:
            output.append(f"{key}={replacements[key]}")
            seen.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in replacements.items() if key not in seen)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(output) + "\n")
    os.chmod(temporary, 0o640)
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("nginx_config", help="Exact managed demo deployment server configuration")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply or os.geteuid() != 0:
        raise RuntimeError("Run as root with --apply during the approved maintenance window.")
    config = pathlib.Path(args.nginx_config).resolve()
    original = config.read_text(encoding="utf-8")
    managed_marker = "# Managed exclusively by the independent Harness project executor."
    has_demo_route = ".demo.daoyintech.com" in original
    if managed_marker not in original or not has_demo_route or original.count("proxy_pass http://127.0.0.1:4715;") != 1:
        raise RuntimeError("The supplied file is not the exact managed legacy deployment route.")
    backup = BACKUP_ROOT / ("resources-cutover-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(config, backup / "nginx.conf")
    shutil.copy2(PROJECT_ENV, backup / "project-service.env")
    shutil.copy2(PROJECT_UNIT, backup / "project.service")
    (backup / "state.json").write_text(json.dumps({"nginx": str(config), "oldUpstream": 4715, "newUpstream": 4712}, indent=2), encoding="utf-8")
    project_unit = PROJECT_UNIT.read_text(encoding="utf-8")
    legacy_after = "After=daoyin-project-executor.service docker.service"
    legacy_requires = "Requires=daoyin-project-executor.service"
    if project_unit.count(legacy_after) != 1 or project_unit.count(legacy_requires) != 1:
        raise RuntimeError("The legacy project service dependency is not in the expected state.")
    try:
        replace_env(PROJECT_ENV, {"HARNESS_PROJECTS_ENABLED": "0", "HARNESS_PROJECTS_BROKER_ONLY": "1"})
        PROJECT_UNIT.write_text(project_unit.replace(legacy_after, "After=docker.service").replace(legacy_requires + "\n", ""), encoding="utf-8")
        DROP_IN.unlink(missing_ok=True)
        command(["systemctl", "daemon-reload"])
        command(["systemctl", "restart", "daoyin-projects.service"])
        dependencies = subprocess.run(["systemctl", "show", "daoyin-projects.service", "--property=Requires", "--value"], check=True, capture_output=True, text=True).stdout.split()
        if "daoyin-project-executor.service" in dependencies:
            raise RuntimeError("Legacy executor dependency is still active after broker-only conversion.")
        config.write_text(original.replace("proxy_pass http://127.0.0.1:4715;", "proxy_pass http://127.0.0.1:4712;"), encoding="utf-8")
        command([str(NGINX), "-t"])
        command([str(NGINX), "-s", "reload"])
        command(["systemctl", "disable", "--now", "daoyin-project-executor.service"])
    except Exception:
        shutil.copy2(backup / "nginx.conf", config)
        shutil.copy2(backup / "project-service.env", PROJECT_ENV)
        shutil.copy2(backup / "project.service", PROJECT_UNIT)
        DROP_IN.unlink(missing_ok=True)
        command(["systemctl", "daemon-reload"])
        command(["systemctl", "enable", "--now", "daoyin-project-executor.service"])
        command(["systemctl", "restart", "daoyin-projects.service"])
        command([str(NGINX), "-t"])
        command([str(NGINX), "-s", "reload"])
        raise
    print(json.dumps({"switched": True, "backup": str(backup), "legacyExecution": False, "legacyDataBroker": True}))


if __name__ == "__main__":
    main()
