"""Real cloud acceptance; no mocked model or storage. Requires authorized active test-account sessions."""
import json,pathlib,subprocess,sys
PROGRAM = pathlib.Path(__file__).with_name('cloud-project-lifecycle-program.py').read_text()
root=pathlib.Path("/opt/daoyin-projects/acceptance")
root.mkdir(exist_ok=True)
p=subprocess.Popen(["docker","exec","-i","daoyintech-backend","python","-u","-c",PROGRAM],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
for line in p.stdout:
 try:event=json.loads(line)
 except ValueError:continue
 if event.get("request")=="restart-project-runtime":
  target="hp-"+event["projectId"][4:]+"-production-"+event["versionId"][4:12]
  subprocess.run(["docker","update","--restart","unless-stopped",target],check=True,capture_output=True)
  subprocess.run(["systemctl","restart","daoyin-projects.service"],check=True,capture_output=True)
  subprocess.run(["docker","restart",target],check=True,capture_output=True)
  p.stdin.write("continue\n");p.stdin.flush()
 elif "report" in event:
  (root/"lifecycle.json").write_text(json.dumps(event["report"],ensure_ascii=False,indent=2))
  print(json.dumps(event["report"],ensure_ascii=False,indent=2),flush=True)
 else:print(json.dumps(event,ensure_ascii=False),flush=True)
status=p.wait()
if status:print(p.stderr.read()[-3500:]);sys.exit(status)
