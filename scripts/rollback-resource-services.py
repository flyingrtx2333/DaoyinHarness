#!/usr/bin/env python3
"""Disable generic admission and restore an exact previous generic release without deleting data."""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

BASE = pathlib.Path("/opt/daoyin-resources")
CONFIG = pathlib.Path("/etc/daoyin-resources/service.env")


def command(args: list[str]) -> None:
    subprocess.run(args, check=True)


def disable_admission() -> None:
    lines = CONFIG.read_text(encoding="utf-8").splitlines()
    replacements = {"HARNESS_RESOURCES_ENABLED": "0", "HARNESS_DEPLOYMENT_EXECUTOR_ENABLED": "0", "HARNESS_GENERAL_RESOURCES_MODE": "off"}
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in replacements:
            output.append(f"{key}={replacements[key]}")
            seen.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in replacements.items() if key not in seen)
    fd, temporary = tempfile.mkstemp(dir=CONFIG.parent, prefix="service.env.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(output) + "\n")
        os.chmod(temporary, 0o640)
        os.replace(temporary, CONFIG)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("revision", help="Exact previous resource release directory name")
    parser.add_argument("--cutover-backup", help="Backup directory created by switch-resource-routes.py")
    args = parser.parse_args()
    target = (BASE / "releases" / args.revision).resolve()
    if not target.is_relative_to(BASE / "releases") or not (target / "release.json").is_file():
        raise RuntimeError("Previous immutable resource release is unavailable.")
    disable_admission()
    next_link = BASE / "current.rollback"
    if next_link.is_symlink():
        next_link.unlink()
    next_link.symlink_to(target, target_is_directory=True)
    next_link.replace(BASE / "current")
    command(["systemctl", "restart", "daoyin-resource-egress.service", "daoyin-resource-executor.service",
             "daoyin-resource-builder.service", "daoyin-resource-deployer.service", "daoyin-resources.service"])
    route_restored = False
    if args.cutover_backup:
        backup = pathlib.Path(args.cutover_backup).resolve()
        state = json.loads((backup / "state.json").read_text(encoding="utf-8"))
        nginx = pathlib.Path(state["nginx"]).resolve()
        shutil.copy2(backup / "nginx.conf", nginx)
        shutil.copy2(backup / "project-service.env", pathlib.Path("/etc/daoyin-projects/service.env"))
        pathlib.Path("/etc/systemd/system/daoyin-projects.service.d/20-broker-only.conf").unlink(missing_ok=True)
        command(["systemctl", "daemon-reload"])
        command(["systemctl", "enable", "--now", "daoyin-project-executor.service"])
        command(["systemctl", "restart", "daoyin-projects.service"])
        command(["/www/server/nginx/sbin/nginx", "-t"])
        command(["/www/server/nginx/sbin/nginx", "-s", "reload"])
        route_restored = True
    print(json.dumps({"rolledBack": True, "release": str(target), "admission": False, "routeRestored": route_restored, "dataDeleted": False}))


if __name__ == "__main__":
    main()
