"""Apply only independent project bridge additions to the current production image."""
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path("/root/DaoyinHarness")
source=pathlib.Path("/root/daoyintech/backend")
stage=pathlib.Path("/opt/daoyin-projects/platform-release")/sys.argv[1]
stage.mkdir(parents=True,exist_ok=False)
def run(args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,**kw)
before=json.loads(run(["docker","inspect","daoyintech-backend"]).stdout)[0]
image=before["Image"]
files=["services/agent_app_access.py","services/saishi_agent_bridge.py","routes/agent_apps.py","services/harness_agent_bridge.py"]
for name in files:
 p=stage/name;p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(run(["docker","exec","daoyintech-backend","cat","/app/"+name]).stdout)
run(["python3",str(root/"scripts/patch-project-platform.py"),str(stage)])
for name,origin in [("services/harness_projects.py",root/"deployment/projects/platform/harness_projects.py"),("services/harness_project_tools.json",root/"deployment/projects/tool-schemas.json")]:
 (stage/name).write_bytes(origin.read_bytes())
config={"allowedUsers":["1","3"]}
(stage/"services/harness_project_admission.json").write_text(json.dumps(config))
for name in files+["services/harness_projects.py"]:
 compile((stage/name).read_text(),name,"exec")
(stage/"Dockerfile").write_text("FROM "+image+"\n"+"".join("COPY "+name+" /app/"+name+"\n" for name in files+["services/harness_projects.py","services/harness_project_tools.json","services/harness_project_admission.json"]))
tag="daoyintech-backend:harness-projects-"+sys.argv[1]
run(["docker","build","-t",tag,str(stage)])
latest=json.loads(run(["docker","inspect","daoyintech-backend"]).stdout)[0]
if latest["Id"]!=before["Id"] or latest["Image"]!=image:raise RuntimeError("Another deployment changed the platform; no running service was replaced")
compose=pathlib.Path("/www/wwwroot/daoyintech/backend/docker-compose.yml")
override=stage/"compose.override.yml"
override.write_text("services:\n  backend:\n    image: "+tag+"\n")
run(["docker","compose","-f",str(compose),"-f",str(override),"up","-d","--no-deps","backend"])
report={"previousImage":image,"image":tag,"sourceFiles":{name:hashlib.sha256((stage/name).read_bytes()).hexdigest() for name in files},"admission":config}
(stage/"release.json").write_text(json.dumps(report,indent=2))
print(json.dumps({"image":tag,"source":"current production image plus exact project-only patches","admission":config}))
