"""Freeze three public Verified tasks; never expose reference or test patches to the Agent."""
import argparse
import hashlib
import json
import pathlib
import urllib.request

DATASET = "princeton-nlp/SWE-bench_Verified"
REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
INSTANCES = ("pytest-dev__pytest-5787", "pytest-dev__pytest-5631", "sympy__sympy-12481")
ROOT = pathlib.Path(__file__).resolve().parent.parent


def fetch(url, maximum):
    with urllib.request.urlopen(url, timeout=30) as response:
        value = response.read(maximum + 1)
    if len(value) > maximum:
        raise RuntimeError("Official dataset response exceeded the bounded download limit")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".cache/swebench-verified-3")
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT / ".cache"):
        parser.error("output must stay inside this repository's .cache directory")
    try:
        import pyarrow.parquet as parquet
        import pyarrow
    except ImportError:
        parser.error("pyarrow is required for preparation; use the isolated .cache/swebench-prep-venv")
    output.mkdir(parents=True, exist_ok=True)
    filename = "data/test-00000-of-00001.parquet"
    metadata = json.loads(fetch(f"https://huggingface.co/api/datasets/{DATASET}/tree/{REVISION}/data", 100_000))
    source = next(entry for entry in metadata if entry["path"] == filename)
    raw = fetch(f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{filename}", 8_000_000)
    digest = hashlib.sha256(raw).hexdigest()
    expected = source.get("lfs", {}).get("oid")
    if expected and digest != expected:
        raise RuntimeError("Pinned official dataset checksum mismatch")
    dataset_path = output / "verified.parquet"
    dataset_path.write_bytes(raw)
    # The grader may read the full pinned dataset; the inference manifest decodes only issue fields.
    rows = parquet.read_table(dataset_path, columns=["instance_id", "repo", "base_commit", "problem_statement", "version"]).to_pylist()
    indexed = {row["instance_id"]: row for row in rows}
    missing = [instance for instance in INSTANCES if instance not in indexed]
    if missing:
        raise RuntimeError("Candidates absent from pinned Verified dataset: " + ", ".join(missing))
    manifest = {"dataset": DATASET, "datasetRevision": REVISION, "datasetSha256": digest,
                "datasetPath": str(dataset_path), "preparationLibrary": f"pyarrow {pyarrow.__version__}",
                "referencePatchExposed": False, "testPatchExposed": False,
                "tasks": [indexed[instance] for instance in INSTANCES]}
    path = output / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "prepared-not-executed", "manifest": str(path), "datasetRevision": REVISION,
                      "instances": [{"id": row["instance_id"], "baseCommit": row["base_commit"]} for row in manifest["tasks"]]}))


if __name__ == "__main__":
    main()
