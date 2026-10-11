"""Operator-owned fresh real-model allowance. Never replay or replace a ledger."""
import argparse
import decimal
import hashlib
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--max-requests", type=int, required=True)
    parser.add_argument("--max-cny", type=decimal.Decimal, required=True)
    parser.add_argument("--expected-provider", required=True)
    parser.add_argument("--expected-model", required=True)
    parser.add_argument("--expected-key-suffix", required=True)
    parser.add_argument("--activate", action="store_true", help="Update only admission paths; never restart services.")
    args = parser.parse_args()
    root = pathlib.Path(args.directory)
    if sys.platform != "linux" or os.getuid() != 0 or not re.fullmatch(r"/var/lib/daoyin-harness/validation/[A-Za-z0-9_-]+", str(root)):
        raise ValueError("Independent Linux server root and a trusted fresh directory are required")
    if not 1 <= args.max_requests <= 10000 or not args.max_cny.is_finite() or not 0 < args.max_cny <= 1000:
        raise ValueError("Invalid explicit allowance")
    maximum = args.max_cny * 1000000
    if maximum != maximum.to_integral_value():
        raise ValueError("Cost allowance must use integral micro-CNY")
    if not all(re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value) for value in (args.expected_provider, args.expected_model)) or not re.fullmatch(r"[A-Za-z0-9]{4,16}", args.expected_key_suffix):
        raise ValueError("Invalid frozen provider, model or credential suffix")
    if root.exists():
        raise ValueError("Existing validation directory must not be replaced")
    environment = pathlib.Path("/etc/daoyin-harness/cloud.env")
    if environment.is_symlink():
        raise ValueError("Admission environment must be a regular operator-owned file")
    before = environment.read_text()
    names = ("DAOYIN_CLOUD_MODEL_ADMISSION_POLICY", "DAOYIN_CLOUD_MODEL_ADMISSION_LEDGER")
    previous = {}
    for name in names:
        matches = re.findall(r"^" + name + r"=(.*)$", before, re.MULTILINE)
        if len(matches) > 1:
            raise ValueError("Duplicate admission environment entry")
        previous[name] = matches[0].strip().strip("\"'") if matches else None
    previous_ledger = pathlib.Path(previous[names[1]]) if previous[names[1]] else None
    prior_hash = hashlib.sha256(previous_ledger.read_bytes()).hexdigest() if previous_ledger else None
    parameters = json.dumps({"provider": args.expected_provider, "model": args.expected_model, "suffix": args.expected_key_suffix})
    program = """import json,hashlib,decimal
from database import get_db
from services.saishi_agent_bridge import AGENT_MODEL_MAX_TOKENS
p=json.loads(PARAMETERS)
with get_db() as c,c.cursor() as q:
 q.execute("SELECT id,scene_key,provider_key,model_name,config_json,is_enabled FROM ai_app_bindings WHERE app_key=%s AND scene_key IN (%s,%s) ORDER BY scene_key",('daoyin-harness','agent_turn','capability_routing')); bindings=q.fetchall()
 assert len(bindings)==2 and all(r['is_enabled'] for r in bindings), 'Scenes unavailable'
 scenes={r['scene_key']:{'id':r['id'],'provider':r['provider_key'],'model':r['model_name'],'config':json.loads(r['config_json']) if isinstance(r['config_json'],str) else r['config_json']} for r in bindings}
 assert all(s['provider']==p['provider'] and s['model']==p['model'] for s in scenes.values()), 'Frozen model mismatch'
 q.execute("SELECT provider_key,model_name,currency,pricing_json,source_url,effective_from,is_enabled FROM ai_model_pricing_rules WHERE provider_key=%s AND model_name=%s",(p['provider'],p['model'])); prices=q.fetchall()
 assert len(prices)==1 and prices[0]['is_enabled'] and prices[0]['currency']=='CNY', 'Actual pricing unavailable'
 pricing=prices[0]; pricing['pricing_json']=json.loads(pricing['pricing_json']) if isinstance(pricing['pricing_json'],str) else pricing['pricing_json']; date=pricing['effective_from']; pricing['effective_from']=date.isoformat() if hasattr(date,'isoformat') else str(date) if date is not None else None
 rate=pricing['pricing_json']; peak=decimal.Decimal(str(rate.get('peak_multiplier',1)))
 assert peak>=1, 'Unknown peak pricing'
 values=[decimal.Decimal(str(rate[k]))*peak*1000000 for k in ['input_per_million','output_per_million']]
 assert all(v.is_finite() and v>=0 for v in values), 'Unknown pricing'
 rates=[int(v.to_integral_value(rounding=decimal.ROUND_CEILING)) for v in values]
 q.execute("SELECT api_key,is_enabled FROM ai_provider_configs WHERE provider_key=%s",(p['provider'],)); rows=q.fetchall()
 assert len(rows)==1 and rows[0]['is_enabled'], 'Existing credential unavailable'
 key=str(rows[0]['api_key'] or '').strip(); assert key and key.endswith(p['suffix']), 'Existing credential changed'
 credential=hashlib.sha256(key.encode()).hexdigest(); key=''
 canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
 facts={'scenes':scenes,'maxOutputTokens':AGENT_MODEL_MAX_TOKENS}
 print(json.dumps({'facts':facts,'pricing':pricing,'inputMicroCnyPerMillion':rates[0],'outputMicroCnyPerMillion':rates[1],'credentialSha256':credential,'modelConfigurationSha256':hashlib.sha256(canonical(facts)).hexdigest(),'pricingSha256':hashlib.sha256(canonical(pricing)).hexdigest()}))
""".replace("PARAMETERS", repr(parameters))
    result = subprocess.run(["docker", "exec", "daoyintech-backend", "python", "-c", program], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Read-only frozen configuration, credential or pricing audit failed; diagnostics withheld")
    frozen = json.loads(result.stdout)
    maximum_output = frozen["facts"]["maxOutputTokens"]
    if not isinstance(maximum_output, int) or not 1 <= maximum_output <= 100000:
        raise ValueError("Invalid actual output token bound")
    policy = {"schemaVersion": 1, "expiresAt": int(time.time() * 1000) + 24 * 3600000, "sessionIds": [],
              "maxRequests": args.max_requests, "maxMicroCny": int(maximum), "provider": args.expected_provider, "model": args.expected_model,
              "inputMicroCnyPerMillion": frozen["inputMicroCnyPerMillion"], "outputMicroCnyPerMillion": frozen["outputMicroCnyPerMillion"],
              "maxOutputTokens": maximum_output, "additionalInputTokenBound": 65536,
              "modelConfigurationSha256": frozen["modelConfigurationSha256"], "pricingSha256": frozen["pricingSha256"],
              "credentialSha256": frozen["credentialSha256"]}
    user = pwd.getpwnam("daoyin-agent")
    root.mkdir(parents=True, mode=0o700); os.chown(root, user.pw_uid, user.pw_gid)
    for name, value in (("policy.json", policy), ("ledger.json", {"schemaVersion": 1, "reservations": []}), ("frozen.json", frozen)):
        file = root / name
        with file.open("x") as output:
            output.write(json.dumps(value, indent=2) + "\n")
        file.chmod(0o600); os.chown(file, user.pw_uid, user.pw_gid)
    activated = False
    if args.activate:
        if previous_ledger and hashlib.sha256(previous_ledger.read_bytes()).hexdigest() != prior_hash:
            raise ValueError("Prior ledger changed during preparation; paths were not activated")
        if environment.read_text() != before:
            raise ValueError("Environment changed concurrently; paths were not activated")
        after = before
        for name, target in zip(names, (root / "policy.json", root / "ledger.json")):
            line = name + "=" + str(target)
            after = re.sub(r"^" + name + r"=.*$", line, after, flags=re.MULTILINE) if previous[name] is not None else after.rstrip("\n") + "\n" + line + "\n"
        info = environment.stat(); temporary = environment.with_name(environment.name + ".next-" + uuid.uuid4().hex)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(after)
        temporary.chmod(info.st_mode & 0o777); os.chown(temporary, info.st_uid, info.st_gid); os.replace(temporary, environment)
        activated = True
    receipt = {"directory": str(root), "maxRequests": args.max_requests, "maxMicroCny": int(maximum),
               "provider": args.expected_provider, "model": args.expected_model, "credentialMatchesExpected": True,
               "previousAdmissionPaths": previous, "previousLedgerSha256": prior_hash,
               "environmentPathsUpdated": activated, "runtimeRestarted": False, "modelCalls": 0}
    (root / "installation.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (root / "installation.json").chmod(0o600)
    print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "not-activated", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
