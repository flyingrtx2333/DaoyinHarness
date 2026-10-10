#!/usr/bin/env python3
"""Switch only the exact server-built executor; an unchanged dependent control may need starting.

Local push and bundle-transfer evidence is recorded separately by the operator.
The server checks its clean main HEAD/origin/main, never contacts GitHub here.
"""
import argparse
import json
import os
import pathlib
import re
import runpy
import signal
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
helpers = runpy.run_path(str(ROOT / "scripts/deploy-resource-builder.py"))
access, digest, command_digest = (helpers[name] for name in ("access", "digest", "command_digest"))
UNIT, CONTROL, NODE = "daoyin-resource-executor.service", access.CONTROL, access.NODE
DROPIN = pathlib.Path(f"/etc/systemd/system/{UNIT}.d/99-harness-executor-release.conf")
PROTECTED = ["daoyin-harness-cloud.service", "daoyin-resource-builder.service", "daoyin-resource-deployer.service",
             "daoyin-resource-buildkit.service", "daoyin-resource-egress.service", "docker.service", "nginx.service"]
LINKS = [pathlib.Path("/opt/daoyin-harness/current"), pathlib.Path("/opt/daoyin-harness/workbench/current"),
         pathlib.Path("/opt/daoyin-resources/current")]
CONFIGS = [pathlib.Path("/etc/daoyin-harness/cloud.env"), pathlib.Path("/etc/daoyin-resources/service.env"),
           pathlib.Path("/etc/daoyin-resources/workspace-subnet-pool.env")]
PG_CHECK = r"""
const fs=require('node:fs'),{createRequire}=require('node:module');
const env=path=>Object.fromEntries(fs.readFileSync(path,'utf8').split('\n').filter(l=>l.trim()&&!l.trim().startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const {Pool}=createRequire('/opt/daoyin-harness/current/package.json')('pg');
async function idle(connectionString,query){
  if(!connectionString)throw new Error('Missing connection');
  const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
  try{const row=(await pool.query(query)).rows[0];if(Object.values(row).some(n=>n!==0))throw new Error('Active jobs');}finally{await pool.end();}
}
(async()=>{try{
  await idle(env('/etc/daoyin-harness/cloud.env').DAOYIN_CLOUD_POSTGRES_URL,"SELECT count(*)::integer AS runs FROM cloud_runs WHERE status IN ('running','queued')");
  await idle(env('/etc/daoyin-resources/service.env').HARNESS_RESOURCES_DATABASE_URL,`SELECT
    (SELECT count(*)::integer FROM harness_workspaces WHERE state='creating') AS workspaces,
    (SELECT count(*)::integer FROM harness_process_sessions WHERE status IN ('starting','running')) AS processes,
    (SELECT count(*)::integer FROM harness_deployments WHERE status IN ('queued','starting')) AS deployments,
    (SELECT count(*)::integer FROM harness_material_analysis_jobs WHERE state IN ('queued','running')) AS material_jobs`);
}catch{process.exitCode=1;}})();
"""


def require_checkout(revision):
    if access.run(["git", "rev-parse", "--show-toplevel"]) != str(ROOT) or \
            access.run(["git", "branch", "--show-current"]) != "main" or access.run(["git", "status", "--porcelain"]):
        raise RuntimeError("Use the clean authoritative server main checkout.")
    if any(access.run(["git", "rev-parse", ref]) != revision for ref in ["HEAD", "origin/main"]):
        raise RuntimeError("Server HEAD and origin/main must match the exact transferred pushed revision.")
    access.run(["git", "cat-file", "-e", revision + ":packages/server-cloud/src/resources/executor.ts"])


def require_release(revision):
    release = pathlib.Path("/opt/daoyin-resources/releases") / revision
    if release.resolve(strict=True) != release:
        raise RuntimeError("Candidate must be a regular immutable exact-revision release directory.")
    manifest_path = release / "release.json"
    if manifest_path.is_symlink():
        raise RuntimeError("Release manifest must be a regular file.")
    encoded = manifest_path.read_bytes()
    manifest = json.loads(encoded)
    files = manifest.get("files")
    required = {"executor.mjs", "service.mjs", "builder.mjs", "deployment.mjs", "egress.mjs", "migrate.mjs", "policy.mjs", "schema.sql", "tool-schemas.json"}
    if manifest.get("sourceRevision") != revision or manifest.get("sourceState") != "committed-resource-sources" or \
            manifest.get("preview") or manifest.get("baseRevision") or not isinstance(files, dict) or not required.issubset(files):
        raise RuntimeError("Candidate manifest must identify the complete exact committed resource build.")
    for name, expected in files.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.\-/]{1,512}", name):
            raise RuntimeError("Candidate file path is invalid.")
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or relative.as_posix() != name or any(part in [".", ".."] for part in relative.parts) or \
                not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise RuntimeError("Candidate file manifest is invalid.")
        target = release / name
        if target.resolve(strict=True) != target or not target.is_file() or digest(target.read_bytes()) != expected:
            raise RuntimeError("Candidate artifact integrity check failed.")
    return release, {"manifestSha256": digest(encoded), "builtAt": manifest.get("builtAt"), "files": files}


def protected_state():
    units = {}
    for unit in PROTECTED:
        if not access.active(unit):
            raise RuntimeError("A protected service is not active.")
        units[unit] = {"pid": access.run(["systemctl", "show", unit, "-p", "MainPID", "--value"]),
                       "startedAtMonotonic": access.run(["systemctl", "show", unit, "-p", "ExecMainStartTimestampMonotonic", "--value"]),
                       "execStartSha256": command_digest(unit)}
    links = {}
    for path in LINKS:
        if not path.is_symlink():
            raise RuntimeError("Protected release paths must remain symlinks.")
        links[str(path)] = os.readlink(path)
    configs = {str(path): digest(path.read_bytes()) if path.exists() else None for path in CONFIGS}
    ids = access.run(["docker", "ps", "-a", "-q"]).split()
    containers = access.run(["docker", "inspect", "--format", "{{.Id}} {{.Name}} {{.Config.Image}} {{.State.Status}} {{.State.StartedAt}}", *ids]) if ids else ""
    return {"units": units, "links": links, "configs": configs, "containersSha256": digest("\n".join(sorted(containers.splitlines())).encode()),
            "controlExecStartSha256": command_digest(CONTROL)}


def idle():
    access.run([NODE, "-e", PG_CHECK])
    if access.run(["docker", "ps", "--filter", "label=daoyin.harness.resource=1", "-q"]):
        raise RuntimeError("Active workspace containers exist.")
    for unit in [UNIT, CONTROL, "daoyin-resource-builder.service", "daoyin-resource-deployer.service"]:
        group = access.run(["systemctl", "show", unit, "-p", "ControlGroup", "--value"])
        if not re.fullmatch(r"/system.slice/[A-Za-z0-9_.-]+", group):
            raise RuntimeError("Resource worker cgroup cannot be verified.")
        pids = {pid for file in (pathlib.Path("/sys/fs/cgroup") / group.lstrip("/")).rglob("cgroup.procs") for pid in file.read_text().split()}
        pid = access.run(["systemctl", "show", unit, "-p", "MainPID", "--value"])
        if not pid.isdigit() or int(pid) == 0 or pids != {pid}:
            raise RuntimeError("A resource worker is unavailable or has active child work.")


def process_command(unit):
    pid = access.run(["systemctl", "show", unit, "-p", "MainPID", "--value"])
    return pid, pathlib.Path(f"/proc/{pid}/cmdline").read_bytes()


def verify_scope(previous):
    if protected_state() != previous:
        raise RuntimeError("A protected service, configuration, release link or container changed.")


def start_original_control(report):
    if not access.active(CONTROL):
        access.run(["systemctl", "start", CONTROL])
        report["startedUnits"].append(CONTROL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", required=True, metavar="EXACT_PUSHED_COMMIT")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0 or not re.fullmatch(r"[a-f0-9]{40}", args.apply):
        raise RuntimeError("Use independent Linux root --apply EXACT_PUSHED_COMMIT.")
    os.chdir(ROOT)
    require_checkout(args.apply)
    release, manifest = require_release(args.apply)
    if DROPIN.is_symlink() or DROPIN.parent.resolve() != DROPIN.parent:
        raise RuntimeError("Executor release drop-in must not be a symlink.")
    previous_dropin = DROPIN.read_bytes() if DROPIN.exists() else None
    previous_mode = DROPIN.stat().st_mode & 0o777 if previous_dropin is not None else 0o600
    if not access.active(UNIT) or not access.active(CONTROL):
        raise RuntimeError("Executor and original resource control must already be active.")
    idle()
    if not access.ready():
        raise RuntimeError("Initial resource/cloud readiness is unconfirmed.")
    previous = protected_state()
    _, previous_command = process_command(UNIT)
    _, control_command = process_command(CONTROL)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    journal = pathlib.Path(f"/opt/daoyin-harness/deployments/{stamp}-executor-release-{args.apply[:12]}-{os.getpid()}.json")
    report = {"revision": args.apply, "phase": "preflight", "artifact": str(release / "executor.mjs"), "manifest": manifest,
              "previous": previous, "previousExecutorCommandSha256": digest(previous_command), "restartedUnits": [], "startedUnits": [],
              "runtimeChanged": False, "resourceCurrentChanged": False, "uiChanged": False, "realModelValidation": "not-run"}
    if previous_dropin is not None:
        access.atomic(journal.with_suffix(".rollback"), previous_dropin)
    access.atomic(journal, (json.dumps(report, indent=2) + "\n").encode())
    changed = False

    def interrupted(_number, _frame):
        raise InterruptedError("Executor deployment interrupted.")

    for number in [signal.SIGINT, signal.SIGTERM, signal.SIGALRM]:
        signal.signal(number, interrupted)
    signal.alarm(180)
    try:
        require_checkout(args.apply)
        require_release(args.apply)
        verify_scope(previous)
        idle()
        changed = True
        access.atomic(DROPIN, f"[Service]\nExecStart=\nExecStart={NODE} {release}/executor.mjs\n".encode())
        access.run(["systemctl", "daemon-reload"])
        access.run(["systemctl", "restart", UNIT])
        report["restartedUnits"].append(UNIT)
        start_original_control(report)
        if not access.ready():
            raise RuntimeError("Candidate resource/cloud readiness is unconfirmed.")
        pid, command = process_command(UNIT)
        if command.rstrip(b"\0").split(b"\0") != [NODE.encode(), str(release / "executor.mjs").encode()]:
            raise RuntimeError("Executor is not running the exact candidate artifact.")
        if process_command(CONTROL)[1] != control_command:
            raise RuntimeError("Resource control did not retain its original command.")
        verify_scope(previous)
        report.update(phase="deployed", executorPid=pid)
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
                start_original_control(report)
                ready = access.ready()
                verify_scope(previous)
                if process_command(UNIT)[1] != previous_command or process_command(CONTROL)[1] != control_command:
                    raise RuntimeError("Original component commands were not restored.")
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
        print(json.dumps({"phase": "preflight-failed", "message": "Executor preflight failed; protected output withheld."}), file=sys.stderr)
        sys.exit(1)
