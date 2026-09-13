"""Server-only independent project service installation; never restarts Docker or modifies Builder."""
import json, os, pathlib, pwd, grp, secrets, subprocess, sys, time
ROOT = pathlib.Path("/root/DaoyinHarness")
RELEASE = pathlib.Path(sys.argv[1]).resolve()
assert RELEASE.is_relative_to(pathlib.Path("/opt/daoyin-projects/releases"))
def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)
for group in ("daoyin-projects", "daoyin-project-executor"):
    try: grp.getgrnam(group)
    except KeyError: run(["groupadd", "--system", group])
try: account = pwd.getpwnam("daoyin-projects")
except KeyError:
    run(["useradd", "--system", "--gid", "daoyin-projects", "--home-dir", "/var/lib/daoyin-project-service", "--shell", "/sbin/nologin", "daoyin-projects"])
    account = pwd.getpwnam("daoyin-projects")
gid = grp.getgrnam("daoyin-projects").gr_gid
agent_gid = grp.getgrnam("daoyin-agent").gr_gid
executor_gid = grp.getgrnam("daoyin-project-executor").gr_gid
config = pathlib.Path("/etc/daoyin-projects")
config.mkdir(mode=0o750, exist_ok=True)
os.chown(config, 0, gid)
envfile = config/"service.env"
if not envfile.exists():
    dbpass = secrets.token_hex(32)
    values = {"HARNESS_PROJECTS_DATABASE_URL": f"postgresql://postgres:{dbpass}@localhost/harness_projects?host=/run/daoyin-projects-db",
              "HARNESS_PROJECTS_BROKER_KEY": secrets.token_hex(32), "HARNESS_PROJECTS_ALLOWED_USERS": "1",
              "HARNESS_PROJECTS_ENABLED": "0", "HARNESS_PROJECT_CONTROL_GID": str(agent_gid)}
    envfile.write_text("".join(f"{k}={v}\n" for k,v in values.items()))
    os.chmod(envfile,0o640); os.chown(envfile,0,gid)
    dbfile=config/"database.env"
    dbfile.write_text(f"POSTGRES_PASSWORD={dbpass}\nPOSTGRES_DB=harness_projects\nPOSTGRES_INITDB_ARGS=--auth-local=scram-sha-256\n")
    os.chmod(dbfile,0o600)
socketdir=pathlib.Path("/run/daoyin-projects-db")
socketdir.mkdir(exist_ok=True)
os.chown(socketdir,999,gid); os.chmod(socketdir,0o750)
existing=run(["docker","ps","-a","--filter","name=^harness-projects-db$","--format","{{.Names}}"]).stdout.strip()
if not existing:
    run(["docker","run","-d","--name","harness-projects-db","--restart","unless-stopped","--network","none",
         "--memory","384m","--memory-swap","384m","--cpus","0.5","--pids-limit","128",
         "--env-file",str(config/"database.env"),"--mount","type=volume,src=harness-projects-postgres,dst=/var/lib/postgresql/data",
         "--mount",f"type=bind,src={socketdir},dst=/var/run/postgresql","postgres:16-alpine",
         "-c","listen_addresses=","-c","max_connections=30","-c","shared_buffers=64MB","-c","unix_socket_permissions=0777"])
for _ in range(30):
    probe=subprocess.run(["docker","exec","harness-projects-db","pg_isready","-U","postgres","-d","harness_projects"],capture_output=True)
    if probe.returncode==0:break
    time.sleep(1)
else:raise RuntimeError("Independent project PostgreSQL did not become ready")
run(["docker","exec","-i","harness-projects-db","sh","-c",'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h /var/run/postgresql -U postgres -d harness_projects -v ON_ERROR_STOP=1'],
    input=(ROOT/"packages/server-cloud/src/projects/schema.sql").read_text())
# Persist the socket directory across reboots; the database itself uses its independent Docker volume.
pathlib.Path("/etc/tmpfiles.d/daoyin-projects.conf").write_text(f"d /run/daoyin-projects-db 0750 999 {gid} -\n")
runtime=pathlib.Path("/opt/daoyin-harness/current").resolve()
dependencies=RELEASE/"node_modules"
if not dependencies.exists():dependencies.symlink_to(runtime/"node_modules",target_is_directory=True)
image=run(["docker","image","inspect","daoyin-harness-app:20260913","--format","{{.Id}}"]).stdout.strip()
executor_env=config/"executor.env"
executor_env.write_text(f"HARNESS_PROJECT_GID={executor_gid}\nHARNESS_PROJECT_IMAGE={image}\n")
os.chmod(executor_env,0o600)
control=pathlib.Path("/run/daoyin-projects")
control.mkdir(exist_ok=True);os.chown(control,account.pw_uid,agent_gid);os.chmod(control,0o750)
socket_parent=pathlib.Path("/var/lib/daoyin-projects")
socket_parent.mkdir(exist_ok=True);os.chown(socket_parent,0,gid);os.chmod(socket_parent,0o750)
node="/opt/daoyin-harness/node/bin/node"
units={
"daoyin-project-executor.service":f"""[Unit]
Description=Daoyin independent gVisor project executor
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
EnvironmentFile={executor_env}
ExecStart={node} {RELEASE}/executor.mjs
Restart=on-failure
RestartSec=5
UMask=0022
[Install]
WantedBy=multi-user.target
""",
"daoyin-projects.service":f"""[Unit]
Description=Daoyin independent cloud projects and application gateway
After=daoyin-project-executor.service docker.service
Requires=daoyin-project-executor.service
[Service]
Type=simple
User=daoyin-projects
Group=daoyin-projects
SupplementaryGroups=daoyin-agent daoyin-project-executor
EnvironmentFile={envfile}
ExecStartPre=+/usr/bin/install -d -m 0750 -o daoyin-projects -g daoyin-agent /run/daoyin-projects
ExecStart={node} {RELEASE}/service.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/run/daoyin-projects
ProtectHome=yes
PrivateTmp=yes
UMask=0027
[Install]
WantedBy=multi-user.target
"""}
for name,body in units.items():pathlib.Path("/etc/systemd/system",name).write_text(body)
run(["systemctl","daemon-reload"])
run(["systemctl","enable","daoyin-project-executor.service","daoyin-projects.service"])
run(["systemctl","restart","daoyin-project-executor.service"])
run(["systemctl","restart","daoyin-projects.service"])
print(json.dumps({"services":"started","release":str(RELEASE),"publicAdmission":False,"allowedTestActors":["1"]}))
