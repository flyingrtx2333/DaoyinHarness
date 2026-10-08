#!/usr/bin/env python3
"""Prepare only three pinned public base sources; no model, gold data or repository execution."""
import datetime
import gzip
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
PINS = {
    "pytest-dev__pytest-5787": ("pytest-dev/pytest", "955e54221008aba577ecbaefa15679f6777d3bf8"),
    "pytest-dev__pytest-5631": ("pytest-dev/pytest", "cb828ebe70b4fa35cd5f9a7ee024272237eab351"),
    "sympy__sympy-12481": ("sympy/sympy", "c807dfe7569692cad24f02a08477b70c1679a4dd"),
}
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_SOURCE = 256 * 1024 * 1024
MAX_FILES = 30_000
ENV = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
       "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "LC_ALL": "C"}
for variable in list(ENV):
    if variable.startswith("GIT_CONFIG_") and variable not in ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]:
        del ENV[variable]
for variable in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]:
    ENV.pop(variable, None)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def safe_text(value):
    value = re.sub(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/<>\"'@]+@", r"\1[REDACTED]@", value)
    return re.sub(r"(?i)bearer\s+[a-z0-9._~+/-]{8,}", "[REDACTED]", value)


def save(path, value):
    encoded = (json.dumps(value, indent=2) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(encoded)
    return {"file": str(path), "sha256": sha(encoded), "bytes": len(encoded)}


def command(git, repository, receipt_directory, receipts, args, timeout=60):
    began = time.monotonic()
    result = subprocess.run([git, *args], cwd=repository, env=ENV, capture_output=True, timeout=timeout, check=False)
    if len(result.stdout) + len(result.stderr) > 200_000:
        raise RuntimeError("Git diagnostics exceeded their bounded receipt limit")
    receipt = {"executable": git, "args": args, "cwd": str(repository), "exitCode": result.returncode,
               "durationMs": round((time.monotonic() - began) * 1000),
               "stdout": safe_text(result.stdout.decode("utf8", errors="replace")),
               "stderr": safe_text(result.stderr.decode("utf8", errors="replace")), "sanitized": True}
    receipts.append(save(receipt_directory / f"git-{len(receipts) + 1:03}.json", receipt))
    if result.returncode:
        raise RuntimeError("Actual public-source Git command failed; inspect its sanitized receipt")
    return result.stdout.decode("utf8")


def archive_source(repository, target):
    paths = sorted(repository.rglob("*"), key=lambda item: item.relative_to(repository).as_posix())
    if len(paths) > MAX_FILES:
        raise RuntimeError("Source file-count bound exceeded")
    total = 0
    for path in paths:
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
        elif stat.S_ISLNK(info.st_mode):
            if os.path.isabs(os.readlink(path)) or not path.resolve().is_relative_to(repository):
                raise RuntimeError("Source contains an escaping symlink")
        elif not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("Source contains a non-file archive entry")
    if total > MAX_SOURCE:
        raise RuntimeError("Uncompressed source bound exceeded")
    with target.open("xb") as raw:
        os.chmod(target, 0o600)
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in paths:
                    name = path.relative_to(repository).as_posix()
                    entry = archive.gettarinfo(str(path), arcname=name)
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ""
                    entry.mtime = 0
                    entry.pax_headers = {}
                    entry.mode = 0o755 if entry.isdir() or entry.mode & 0o111 else 0o644
                    if entry.isfile():
                        with path.open("rb") as content:
                            archive.addfile(entry, content)
                    else:
                        archive.addfile(entry)
    size = target.stat().st_size
    if size > MAX_ARCHIVE:
        target.unlink()
        raise RuntimeError("Compressed source archive exceeds 32 MiB")
    return {"file": str(target), "bytes": size, "sha256": sha(target.read_bytes()),
            "entries": len(paths), "uncompressedFileBytes": total, "reproducibleMetadata": "sorted entries, uid/gid0, mtime0, fixed modes, gzip mtime0"}


def publish_source_manifest(report):
    if report["status"] != "prepared-public-sources-not-inference":
        raise RuntimeError("Only completed exact source preparation can publish the upload manifest")
    value = {"kind": "swebench-exact-base-source-archives", "dataset": report["dataset"], "datasetRevision": REVISION,
             "issueManifestSha256": report["issueManifestSha256"], "referencePatchExposed": False, "testPatchExposed": False,
             "sourcePreparation": {"scriptSha256": report["scriptSha256"], "environment": report["environment"],
                                   "receipt": report.get("receiptManifest", str(pathlib.Path(report["output"]) / "source-manifest.json"))}, "cases": []}
    for observed in report["sources"]:
        value["cases"].append({"instance_id": observed["instance_id"], "repo": observed["repo"],
                              "baseCommit": observed["base_commit"], "tree": observed["treeHash"], "archive": observed["archive"],
                              "source": {"clean": observed["cleanStatus"] == "", "shallow": observed["shallow"] == "true",
                                         "head": observed["exactHead"], "tree": observed["treeHash"], "commitCount": observed["commitCount"],
                                         "refs": observed["refs"], "remote": observed["remote"], "method": "git-fetch-depth1-exact-base",
                                         "gitConfig": observed["gitConfig"], "receipts": observed["receipts"]}})
    target = ROOT / ".cache/swebench-sources/manifest.json"
    if target.is_symlink():
        raise RuntimeError("Upload manifest must not be a symlink")
    temporary = target.with_name(f".manifest-{uuid.uuid4().hex}.json")
    receipt = save(temporary, value)
    os.replace(temporary, target)
    receipt["file"] = str(target)
    return receipt


def main():
    if len(sys.argv) != 1:
        raise RuntimeError("This fixed sample preparer accepts no alternate refs or dataset input")
    manifest_path = ROOT / ".cache/swebench-verified-3/manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    tasks = manifest.get("tasks")
    if manifest.get("dataset") != "princeton-nlp/SWE-bench_Verified" or manifest.get("datasetRevision") != REVISION or \
            manifest.get("referencePatchExposed") is not False or manifest.get("testPatchExposed") is not False or \
            not isinstance(tasks, list) or [task.get("instance_id") for task in tasks] != list(PINS) or \
            any((task.get("repo"), task.get("base_commit")) != PINS[task["instance_id"]] or
                set(task) - {"instance_id", "repo", "base_commit", "problem_statement", "version"} for task in tasks):
        raise RuntimeError("The exact three issue-only manifest pins do not match")
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Local Git is required")
    output = ROOT / ".cache/swebench-sources" / (datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    output.mkdir(parents=True, mode=0o700)
    report = {"kind": "swebench-pinned-public-source-archives", "dataset": manifest["dataset"], "datasetRevision": REVISION,
              "issueManifestSha256": sha(manifest_bytes), "scriptSha256": sha(pathlib.Path(__file__).read_bytes()),
              "output": str(output), "status": "preparing", "referencePatchRead": False, "testPatchRead": False,
              "fullDatasetRead": False, "modelCalls": 0, "sourceExecution": False, "sources": [],
              "limits": {"archiveBytesPerCase": MAX_ARCHIVE, "uncompressedFileBytesPerCase": MAX_SOURCE, "filesPerCase": MAX_FILES},
              "environment": {"platform": sys.platform, "architecture": platform.machine(), "python": sys.version,
                              "compiler": "not-used; public source not built", "gitGlobalConfig": "disabled", "gitSystemConfig": "disabled"}}
    try:
        for task in tasks:
            case = output / task["instance_id"]
            repository = case / "repository"
            repository.mkdir(parents=True, mode=0o700)
            receipts = case / "receipts"
            receipts.mkdir(mode=0o700)
            observed = {"instance_id": task["instance_id"], "repo": task["repo"], "base_commit": task["base_commit"],
                        "repository": str(repository), "status": "preparing", "receipts": []}
            report["sources"].append(observed)
            run = lambda args, timeout=60: command(git, repository, receipts, observed["receipts"], args, timeout)
            report["environment"]["git"] = run(["--version"]).strip()
            run(["init", "--template=", "--initial-branch=bootstrap"])
            run(["config", "--local", "core.autocrlf", "false"])
            run(["config", "--local", "core.logAllRefUpdates", "false"])
            run(["remote", "add", "origin", f"https://github.com/{task['repo']}.git"])
            run(["fetch", "--depth=1", "--no-tags", "origin", task["base_commit"]], 240)
            run(["checkout", "--detach", task["base_commit"]])
            observed["exactHead"] = run(["rev-parse", "HEAD"]).strip()
            observed["treeHash"] = run(["rev-parse", "HEAD^{tree}"]).strip()
            observed["cleanStatus"] = run(["status", "--porcelain", "--untracked-files=all"])
            observed["refs"] = run(["for-each-ref", "--format=%(refname)"]).splitlines()
            observed["commitCount"] = int(run(["rev-list", "--count", "HEAD"]).strip())
            observed["shallow"] = run(["rev-parse", "--is-shallow-repository"]).strip()
            observed["remote"] = run(["remote", "get-url", "origin"]).strip()
            observed["gitConfig"] = run(["config", "--local", "--list"]).splitlines()
            if observed["exactHead"] != task["base_commit"] or observed["cleanStatus"] or observed["refs"] or \
                    observed["commitCount"] != 1 or observed["shallow"] != "true" or \
                    (repository / ".git/shallow").read_text().strip() != task["base_commit"] or \
                    observed["remote"] != f"https://github.com/{task['repo']}.git" or \
                    any(not value.startswith(("core.", "remote.origin.url=", "remote.origin.fetch=")) for value in observed["gitConfig"]):
                raise RuntimeError("Actual checkout has unexpected commit, refs, modifications or credential configuration")
            names = [path.name for path in repository.iterdir()]
            if any(name in [".harness", "lost+found"] or name.startswith((".harness-restore-", "__harness_swe_runtime_", "__harness_prediction_")) for name in names):
                raise RuntimeError("Pinned source collides with reserved runtime filenames")
            # The checkout retains HEAD/index/objects/shallow and credential-free
            # origin metadata; no tags, branches, later history or generated logs.
            (repository / ".git/FETCH_HEAD").unlink(missing_ok=True)
            run(["remote", "remove", "origin"])
            run(["config", "--local", "--unset-all", "core.autocrlf"])
            observed["gitConfig"] = run(["config", "--local", "--list"]).splitlines()
            for key in ["core.ignorecase", "core.precomposeunicode"]:
                if any(value.startswith(key + "=") for value in observed["gitConfig"]):
                    run(["config", "--local", "--unset-all", key])
            observed["gitConfig"] = run(["config", "--local", "--list"]).splitlines()
            if set(observed["gitConfig"]) != {"core.repositoryformatversion=0", "core.filemode=true", "core.bare=false", "core.logallrefupdates=false"}:
                raise RuntimeError("Archive Git configuration is not the minimal command-free contract")
            if any(path.is_symlink() or (path.is_file() and path.stat().st_nlink != 1) for path in repository.rglob("*")):
                raise RuntimeError("The public source archive must not contain symlinks or hardlinks")
            observed["archive"] = archive_source(repository, case / "source.tar.gz")
            observed["status"] = "prepared-exact-clean-shallow-base"
            print(json.dumps({"instance_id": task["instance_id"], "status": observed["status"], "archive": observed["archive"]}), flush=True)
        report["status"] = "prepared-public-sources-not-inference"
    except Exception as error:
        report["status"] = "preparation-failed"
        report["failure"] = {"type": type(error).__name__, "message": safe_text(str(error))[:500]}
    receipt = save(output / "source-manifest.json", report)
    published = publish_source_manifest(report) if report["status"] == "prepared-public-sources-not-inference" else None
    print(json.dumps({"status": report["status"], "manifest": receipt, "uploadManifest": published}), flush=True)
    return 0 if report["status"] == "prepared-public-sources-not-inference" else 1


if __name__ == "__main__":
    sys.exit(main())
