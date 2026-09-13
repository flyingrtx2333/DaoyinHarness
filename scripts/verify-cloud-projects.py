"""Bounded real-model cloud acceptance; actual account, gateway, tools and storage only."""
import json,pathlib,subprocess,sys
mode=sys.argv[1]
assert mode in {"inspect","iterate","publish","status","create"}
program = pathlib.Path(__file__).with_name('cloud-project-model-program.py').read_text()
r=subprocess.run(["docker","exec","-i","daoyintech-backend","python","-",mode],input=program,text=True,capture_output=True)
if r.returncode:
 print(r.stderr[-4000:]);raise SystemExit(r.returncode)
report=json.loads(r.stdout.strip().splitlines()[-1])
out=pathlib.Path("/opt/daoyin-projects/acceptance");out.mkdir(exist_ok=True)
(out/(mode+".json")).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!="diagnostics"},ensure_ascii=False,indent=2))
