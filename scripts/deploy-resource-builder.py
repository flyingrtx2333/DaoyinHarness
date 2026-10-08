#!/usr/bin/env python3
"""Activate an exact server-built builder artifact without switching other releases."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import signal
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("harness_builder_access", ROOT / "scripts/deploy-resource-builder-access.py")
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
UNIT, CONTROL, NODE = access.UNIT, access.CONTROL, access.NODE
DROPIN = pathlib.Path(f"/etc/systemd/system/{UNIT}.d/90-harness-builder-release.conf")
PROTECTED = ["daoyin-harness-cloud.service", "daoyin-resource-executor.service",
             "daoyin-resource-deployer.service", "daoyin-resource-buildkit.service", "docker.service", "nginx.service"]
LINKS = [pathlib.Path("/opt/daoyin-harness/current"), pathlib.Path("/opt/daoyin-resources/current")]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require_checkout(revision):
    if access.run(["git", "rev-parse", "--show-toplevel"]) != str(ROOT):
        raise RuntimeError("Use the authoritative independent server checkout.")
    if access.run(["git", "branch", "--show-current"]) != "main" or access.run(["git", "status", "--porcelain"]):
        raise RuntimeError("Server main checkout must be clean.")
    if any(access.run(["git", "rev-parse", ref]) != revision for ref in ["HEAD", "origin/main"]):
        raise RuntimeError("Checkout must match the exact pushed revision.")
    remote = access.run(["git", "ls-remote", "--exit-code", "origin", "refs/heads/main"]).split()
    if remote != [revision, "refs/heads/main"]:
        raise RuntimeError("Live origin/main does not match the requested revision.")


def require_release(revision):
    release = pathlib.Path("/opt/daoyin-resources/releases") / revision
    if release.is_symlink() or release.resolve(strict=True) != release:
        raise RuntimeError("Candidate must be an exact immutable resource release directory.")
    manifest_path = release / "release.json"
    if manifest_path.is_symlink():
        raise RuntimeError("Release manifest must be a regular file.")
    encoded = manifest_path.read_bytes()
    manifest = json.loads(encoded)
    files = manifest.get("files")
    required = {"service.mjs", "executor.mjs", "builder.mjs", "deployment.mjs", "egress.mjs", "migrate.mjs",
                "policy.mjs", "schema.sql", "tool-schemas.json"}
    if manifest.get("sourceRevision") != revision or manifest.get("sourceState") != "committed-resource-sources" or \
            manifest.get("preview") or manifest.get("baseRevision") or not isinstance(files, dict) or not required.issubset(files):
        raise RuntimeError("Candidate manifest must identify a complete committed resource build at the exact revision.")
    for name, expected in files.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in [".", ".."] or not re.fullmatch(r"[a-f0-9]{64}", str(expected)):
            raise RuntimeError("Candidate file manifest is invalid.")
        target = release / name
        if target.is_symlink() or not target.is_file() or digest(target.read_bytes()) != expected:
            raise RuntimeError("Candidate artifact integrity check failed.")
    # Dependencies are prepared with the server build; this narrow deployment
    # never installs packages or changes any existing dependency/release link.
    if not (release / "node_modules").is_dir():
        raise RuntimeError("Prepare candidate production dependencies before deploying the builder.")
    return release, {"manifestSha256": digest(encoded), "builtAt": manifest.get("builtAt"), "files": files}


def protected_state():
    units = {}
    for unit in PROTECTED:
        if not access.active(unit):
            raise RuntimeError("A protected service is not active.")
        units[unit] = {"pid": access.run(["systemctl", "show", unit, "--property=MainPID", "--value"]),
                       "execStartSha256": command_digest(unit)}
    links = {}
    for path in LINKS:
        if not path.is_symlink():
            raise RuntimeError("Protected current paths must be release symlinks.")
        links[str(path)] = os.readlink(path)
    groups = access.run(["systemctl", "show", UNIT, "--property=SupplementaryGroups", "--value"])
    if "daoyin-resources" not in groups.split():
        raise RuntimeError("Deploy verified builder shared-group access before switching its artifact.")
    pid = access.run(["systemctl", "show", UNIT, "--property=MainPID", "--value"])
    process_groups = next(line.split()[1:] for line in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("Groups:"))
    return {"units": units, "links": links, "supplementaryGroups": sorted(groups.split()),
            "processGroups": sorted(process_groups),
            "accessDropinSha256": digest(access.DROPIN.read_bytes()) if access.DROPIN.exists() else None,
            "controlExecStartSha256": command_digest(CONTROL)}


def command_digest(unit):
    value = access.run(["systemctl", "show", unit, "--property=ExecStart", "--value"])
    # ExecStart also contains mutable last-start PID/timestamps. Compare only
    # its executable and argv so a dependency-stopped control can be started.
    commands = re.findall(r"path=([^;]+);\s*argv\[\]=([^;]+);", value)
    if not commands:
        raise RuntimeError("Cannot verify the protected service command.")
    return digest(json.dumps(commands).encode())


def builder_command_digest():
    pid = access.run(["systemctl", "show", UNIT, "--property=MainPID", "--value"])
    return digest(pathlib.Path(f"/proc/{pid}/cmdline").read_bytes())


def verify_scope(previous):
    if protected_state() != previous:
        raise RuntimeError("A protected release, service process, command, or builder group configuration changed.")


def verify_builder(entry):
    if not access.active(UNIT):
        raise RuntimeError("Builder is not active.")
    pid = access.run(["systemctl", "show", UNIT, "--property=MainPID", "--value"])
    command = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    if command != [NODE.encode(), str(entry).encode()]:
        raise RuntimeError("Running builder command does not identify the exact candidate artifact.")
    return pid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", required=True, metavar="EXACT_PUSHED_COMMIT")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0 or not re.fullmatch(r"[a-f0-9]{40}", args.apply):
        raise RuntimeError("Use independent Linux root --apply EXACT_PUSHED_COMMIT.")
    os.chdir(ROOT)
    require_checkout(args.apply)
    release, manifest = require_release(args.apply)
    if DROPIN.is_symlink():
        raise RuntimeError("Builder release drop-in must not be a symlink.")
    previous_dropin = DROPIN.read_bytes() if DROPIN.exists() else None
    previous_mode = DROPIN.stat().st_mode & 0o777 if previous_dropin is not None else 0o600
    for unit in [UNIT, CONTROL]:
        if not access.active(unit):
            raise RuntimeError("Builder and original control must already be active.")
    previous = protected_state()
    previous_builder_command = builder_command_digest()
    access.idle()
    if not access.ready():
        raise RuntimeError("Initial builder/resource/cloud readiness is unconfirmed.")
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    journal = pathlib.Path(f"/opt/daoyin-harness/deployments/{stamp}-builder-release-{args.apply[:12]}-{os.getpid()}.json")
    report = {"revision": args.apply, "phase": "preflight", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "artifact": str(release / "builder.mjs"), "manifest": manifest, "previous": previous,
              "previousBuilderCommandSha256": previous_builder_command,
              "restartedUnits": [], "startedUnits": [], "runtimeChanged": False, "resourceCurrentChanged": False,
              "uiChanged": False, "dockerChanged": False, "buildkitChanged": False, "realModelValidation": "not-run"}
    if previous_dropin is not None:
        access.atomic(journal.with_suffix(".rollback"), previous_dropin)
    access.atomic(journal, (json.dumps(report, indent=2) + "\n").encode())
    changed = False

    def interrupted(_number, _frame):
        raise InterruptedError("Builder release deployment interrupted.")

    for number in [signal.SIGINT, signal.SIGTERM, signal.SIGALRM]:
        signal.signal(number, interrupted)
    signal.alarm(180)
    try:
        require_checkout(args.apply)
        require_release(args.apply)
        verify_scope(previous)
        access.idle()
        changed = True
        access.atomic(DROPIN, f"[Service]\nExecStart=\nExecStart={NODE} {release}/builder.mjs\n".encode())
        access.run(["systemctl", "daemon-reload"])
        access.run(["systemctl", "restart", UNIT])
        report["restartedUnits"].append(UNIT)
        if not access.active(CONTROL):
            access.run(["systemctl", "start", CONTROL])
            report["startedUnits"].append(CONTROL)
        if not access.ready():
            raise RuntimeError("Candidate builder/resource/cloud readiness is unconfirmed.")
        report["builderPid"] = verify_builder(release / "builder.mjs")
        verify_scope(previous)
        report["phase"] = "deployed"
    except Exception as error:
        report.update(phase="failed", failure=str(error)[:300])
        signal.alarm(180)
        for number in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(number, signal.SIG_IGN)
        if changed:
            try:
                if previous_dropin is None:
                    DROPIN.unlink(missing_ok=True)
                else:
                    access.atomic(DROPIN, previous_dropin, previous_mode)
                access.run(["systemctl", "daemon-reload"])
                access.run(["systemctl", "restart", UNIT])
                if not access.active(CONTROL):
                    access.run(["systemctl", "start", CONTROL])
                    report["startedUnits"].append(CONTROL)
                ready = access.ready()
                verify_scope(previous)
                if builder_command_digest() != previous_builder_command:
                    raise RuntimeError("Previous builder command restoration is unconfirmed.")
                report["rollback"] = "restored-and-ready" if ready else "restored-readiness-unconfirmed"
            except Exception:
                report["rollback"] = "restoration-unconfirmed"
    finally:
        signal.alarm(0)
        report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        access.atomic(journal, (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({**report, "journal": str(journal)}))
    return 0 if report["phase"] == "deployed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"phase": "preflight-failed", "message": "Deployment preflight failed; child output withheld."}), file=sys.stderr)
        sys.exit(1)
