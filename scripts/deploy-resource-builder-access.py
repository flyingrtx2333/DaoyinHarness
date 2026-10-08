#!/usr/bin/env python3
"""Exact-source builder access deployment; no release, Docker or shared-permission changes."""
import argparse, grp, http.client, json, os, pathlib, pwd, re, signal, socket, subprocess, sys, tempfile, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent.parent
UNIT, CONTROL = "daoyin-resource-builder.service", "daoyin-resources.service"
DROPIN = pathlib.Path(f"/etc/systemd/system/{UNIT}.d/90-harness-builder-access.conf")
STATE = pathlib.Path("/var/lib/daoyin-resources")
NODE = "/opt/daoyin-harness/node/bin/node"
PG_CHECK = r"""
const fs=require('node:fs'),{createRequire}=require('node:module');
const env=Object.fromEntries(fs.readFileSync('/etc/daoyin-harness/cloud.env','utf8').split('\n').filter(l=>l.trim()&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const {Pool}=createRequire('/opt/daoyin-harness/current/package.json')('pg');
const p=new Pool({connectionString:env.DAOYIN_CLOUD_POSTGRES_URL,max:1,connectionTimeoutMillis:5000,query_timeout:5000});
(async()=>{try{const r=await p.query("SELECT count(*)::integer AS n FROM cloud_runs WHERE status IN ('running','queued')");process.exitCode=r.rows[0].n?2:0;}catch{process.exitCode=3;}finally{await p.end();}})();
"""
def run(args):
    try: return subprocess.run(args,check=True,capture_output=True,text=True,timeout=30).stdout.strip()
    except (subprocess.SubprocessError,OSError): raise RuntimeError(f"Command failed: {args[0]}; output withheld.") from None

def active(unit): return run(["systemctl","show",unit,"--property=ActiveState","--value"])=="active"
def atomic(path,data,mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True); temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as stream:
            temporary=pathlib.Path(stream.name); os.fchmod(stream.fileno(),mode); stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)
def idle():
    if run(["docker","ps","--filter","label=daoyin.harness.resource=1","--format","{{.Names}}"]): raise RuntimeError("Active Harness sandbox work.")
    run([NODE,"-e",PG_CHECK]); pid=run(["systemctl","show",UNIT,"--property=MainPID","--value"])
    if not pid.isdigit() or int(pid)==0 or pathlib.Path(f"/proc/{pid}/task/{pid}/children").read_text().strip(): raise RuntimeError("Builder is unavailable or busy.")
def access_probe(probe):
    account=pwd.getpwnam("daoyin-resource-builder"); groups=run(["systemctl","show",UNIT,"--property=SupplementaryGroups","--value"]).split()
    command=["runuser","--user",account.pw_name,"--group",grp.getgrgid(account.pw_gid).gr_name]
    for group in dict.fromkeys([*groups,"daoyin-agent","daoyin-resources"]): command.extend(["--supp-group",group])
    for directory in [STATE,STATE/"workspaces",STATE/"builds"]: run([*command,"--","/usr/bin/test","-x",str(directory)])
    if probe:
        path=pathlib.Path(probe).resolve(strict=True); parts=path.relative_to((STATE/"workspaces").resolve(strict=True)).parts
        if len(parts)!=2 or not re.fullmatch(r"wsp_[a-f0-9]{24}",parts[0]) or parts[1]!="Dockerfile" or not path.is_file(): raise RuntimeError("Probe must be a workspace root Dockerfile.")
        run([*command,"--","/usr/bin/dd",f"if={path}","of=/dev/null","bs=1","count=1","status=none"])
def ready():
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        try:
            if not active(UNIT) or not active(CONTROL): raise RuntimeError("Resource service inactive.")
            with socket.socket(socket.AF_UNIX) as sock: sock.settimeout(5); sock.connect("/run/daoyin-resource-builder/control.sock")
            connection=http.client.HTTPConnection("localhost",timeout=5); connection.sock=socket.socket(socket.AF_UNIX); connection.sock.settimeout(5)
            try:
                connection.sock.connect("/run/daoyin-resources/control.sock"); connection.request("POST","/control",'{"action":"readiness"}',{"Content-Type":"application/json"}); response=connection.getresponse()
                if response.status!=200 or json.loads(response.read(100001)).get("ready") is not True: raise RuntimeError("Resource readiness failed.")
            finally: connection.close()
            with urllib.request.urlopen("http://127.0.0.1:4700/health/ready",timeout=5) as response:
                if response.status!=200 or json.loads(response.read(10001)).get("status")!="ready": raise RuntimeError("Cloud readiness failed.")
            return True
        except (OSError,ValueError,RuntimeError,http.client.HTTPException): time.sleep(1)
    return False

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--apply",required=True); parser.add_argument("--probe-file"); args=parser.parse_args()
    if sys.platform!="linux" or os.geteuid()!=0 or not re.fullmatch(r"[a-f0-9]{40}",args.apply): raise RuntimeError("Use Linux root --apply EXACT_PUSHED_COMMIT.")
    os.chdir(ROOT)
    if run(["git","rev-parse","HEAD"])!=args.apply or run(["git","rev-parse","origin/main"])!=args.apply or run(["git","status","--porcelain"]): raise RuntimeError("Checkout must be clean at exact pushed revision.")
    if DROPIN.is_symlink(): raise RuntimeError("Drop-in must not be a symlink.")
    previous=DROPIN.read_bytes() if DROPIN.exists() else None; mode=DROPIN.stat().st_mode&0o777 if previous is not None else 0o600
    for unit in [UNIT,CONTROL,"daoyin-resource-buildkit.service","daoyin-harness-cloud.service"]:
        if not active(unit): raise RuntimeError("Required Harness services must already be active.")
    access_probe(args.probe_file); idle()
    stamp=time.strftime("%Y%m%dT%H%M%SZ",time.gmtime()); journal=pathlib.Path(f"/opt/daoyin-harness/deployments/{stamp}-builder-access-{args.apply[:12]}-{os.getpid()}.json")
    report={"revision":args.apply,"phase":"preflight","restartedUnits":[],"startedUnits":[],"releaseChanged":False,"sharedPermissionsChanged":False}; changed=False
    if previous is not None: atomic(journal.with_suffix(".rollback"),previous)
    atomic(journal,(json.dumps(report)+"\n").encode())
    def interrupted(_number,_frame): raise InterruptedError("Builder access deployment interrupted.")
    for number in [signal.SIGINT,signal.SIGTERM,signal.SIGALRM]: signal.signal(number,interrupted)
    signal.alarm(180)
    try:
        idle(); changed=True; atomic(DROPIN,b"[Service]\nSupplementaryGroups=daoyin-resources\n"); run(["systemctl","daemon-reload"]); run(["systemctl","restart",UNIT]); report["restartedUnits"].append(UNIT)
        if not active(CONTROL): run(["systemctl","start",CONTROL]); report["startedUnits"].append(CONTROL)
        if not ready(): raise RuntimeError("Builder/resource/cloud readiness unconfirmed.")
        pid=run(["systemctl","show",UNIT,"--property=MainPID","--value"]); groups=next(line.split()[1:] for line in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("Groups:"))
        if str(grp.getgrnam("daoyin-resources").gr_gid) not in groups: raise RuntimeError("Builder shared group not effective.")
        report["phase"]="deployed"
    except Exception as error:
        report.update(phase="failed",failure=str(error)[:300]); signal.alarm(0)
        for number in [signal.SIGINT,signal.SIGTERM,signal.SIGALRM]: signal.signal(number,signal.SIG_IGN)
        if changed:
            try:
                DROPIN.unlink(missing_ok=True) if previous is None else atomic(DROPIN,previous,mode)
                run(["systemctl","daemon-reload"]); run(["systemctl","restart",UNIT])
                if not active(CONTROL): run(["systemctl","start",CONTROL]); report["startedUnits"].append(CONTROL)
                report["rollback"]="restored-and-ready" if ready() else "restored-readiness-unconfirmed"
            except Exception: report["rollback"]="restoration-unconfirmed"
    finally:
        signal.alarm(0); report["finishedAt"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()); atomic(journal,(json.dumps(report,indent=2)+"\n").encode())
    print(json.dumps({**report,"journal":str(journal)})); return 0 if report["phase"]=="deployed" else 1
if __name__=="__main__":
    try: sys.exit(main())
    except Exception: print(json.dumps({"phase":"preflight-failed","message":"Deployment preflight failed; child output withheld."}),file=sys.stderr); sys.exit(1)
