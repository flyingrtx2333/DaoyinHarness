
import asyncio,base64,http.cookiejar,json,secrets,sys,time,urllib.request,urllib.error,uuid
from database import get_db
from services.first_party_accounts import validate_row
from services import agent_app_access as access
from routes.agent_public import cloud_request
report={"evidence":"real-cloud-real-accounts-real-containers","modelCalls":0,"checks":[]}
def passed(name,**data):
 report["checks"].append({"name":name,"passed":True,**data})
 print(json.dumps({"progress":name}),flush=True)
def account(uid):
 with get_db() as conn,conn.cursor() as c:
  c.execute("SELECT * FROM first_party_account_sessions WHERE actor_user_id=%s AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(6) ORDER BY created_at DESC LIMIT 1",(uid,))
  row=c.fetchone();assert row,"Account must have an actual active login"
  session=validate_row(c,row)
 bearer,grant=access.for_account(session);config=access.configured()
 async def api(method,path,body=None):return await cloud_request(config,bearer,method,path,body)
 async def project(action,**body):return await api("POST","projects/control",{"action":action,**body})
 return api,project
class Site:
 def __init__(self,url):
  self.url=url;self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def call(self,path="/",data=None,method=None,origin=None):
  raw=None if data is None else json.dumps(data).encode()
  req=urllib.request.Request(self.url+path,raw,headers={"Content-Type":"application/json","Origin":origin or self.url},method=method)
  try:
   with self.opener.open(req,timeout=30) as r:return r.status,r.read()
  except urllib.error.HTTPError as e:return e.code,e.read()
 def json(self,path,data=None,method=None):
  status,body=self.call(path,data,method);assert status==200,(path,status,body[:180]);return json.loads(body)
async def main():
 api,p=account(1);api2,p2=account(3)
 assert (await p("capabilities"))["ready"] and (await p2("capabilities"))["ready"]
 target=next(v for v in (await p("list"))["projects"] if v["title"]=="云端应用验收")
 pid=target["id"];old=target["activeVersion"];assert old
 other=(await p2("create",title="学校账号隔离验收",requestId="actual-account-isolation-20260913"))["project"]
 assert all(v["id"]!=pid for v in (await p2("list"))["projects"])
 assert all(v["id"]!=other["id"] for v in (await p("list"))["projects"])
 denied=[]
 for caller,foreign in [(p,other["id"]),(p2,pid)]:
  for action,extra in [("get",{}),("files",{}),("write",{"revision":1,"files":[{"path":"index.html","content":"denied"}]}),("ticket",{}),("publish",{"requestId":str(uuid.uuid4())})]:
   try:await caller(action,projectId=foreign,**extra)
   except Exception as e:
    status=getattr(e,"status_code",None);assert status in [403,404],(action,status,str(e)[:150]);denied.append(action)
   else:raise AssertionError("Cross-project access permitted")
 passed("two-platform-accounts-project-isolation",actors=[1,3],deniedActions=denied)
 for path in ["../outside.ts","/etc/passwd","src/../../secret.ts","node_modules/a.ts","C:/secret.ts"]:
  try:await p("write",projectId=pid,revision=target["revision"],files=[{"path":path,"content":"denied"}])
  except Exception as e:assert getattr(e,"status_code",None) in [400,403,422]
  else:raise AssertionError("Unsafe path accepted")
 passed("actual-path-boundary-rejections")
 site=Site("https://"+target["slug"]+".demo.daoyintech.com")
 status,html=site.call();assert status==200
 baseline=html
 creds={"email":"accept-"+secrets.token_hex(5)+"@example.invalid","password":secrets.token_urlsafe(20)}
 user=site.json("/api/auth/register",creds)
 doc=site.json("/api/data/acceptance",{"value":"persistent-production-record"})
 contents=b"Persistent independent Harness upload, actual production."
 upload=site.json("/api/uploads",{"name":"acceptance.txt","data":base64.b64encode(contents).decode()})
 def persistence():
  assert site.json("/api/data/acceptance/"+doc["id"])["data"]["value"]=="persistent-production-record"
  assert site.call("/api/uploads/"+upload["id"])[1]==contents
  assert site.json("/api/auth/me")["user"]["id"]==user["user"]["id"]
 persistence()
 stranger=Site(site.url);stranger.json("/api/auth/register",{"email":"other-"+secrets.token_hex(5)+"@example.invalid","password":secrets.token_urlsafe(20)})
 assert stranger.call("/api/data/acceptance/"+doc["id"])[0]==404
 assert stranger.call("/api/uploads/"+upload["id"])[0]==404
 assert stranger.json("/api/data/acceptance")["items"]==[]
 assert site.call("/api/data/acceptance",{"value":"blocked"},origin="https://evil.example")[0]==403
 passed("production-login-data-upload-and-website-user-isolation")
 preview=Site("https://p-"+pid[4:]+".demo.daoyintech.com")
 assert preview.call()[0]==401
 prepared=(await p("preview",projectId=pid,requestId=str(uuid.uuid4())))["operation"]
 for _ in range(60):
  prepared=next(v for v in (await p("operations",projectId=pid))["operations"] if v["id"]==prepared["id"])
  if prepared["status"] not in ["queued","running"]:break
  await asyncio.sleep(1)
 assert prepared["status"]=="completed",prepared
 ticket=(await p("ticket",projectId=pid))["url"]
 with preview.opener.open(ticket,timeout=30) as response:assert response.status==200
 assert preview.call("/api/auth/login",creds)[0]==401
 passed("preview-login-and-development-production-database-separation")
 files=(await p("files",projectId=pid))["files"];source={f["path"]:f["content"] for f in files}
 async def write(files):
  current=(await p("get",projectId=pid))["project"]
  return await p("write",projectId=pid,revision=current["revision"],files=[{"path":k,"content":v} for k,v in files.items()])
 async def enqueue(kind,**extra):
  return (await p(kind,projectId=pid,requestId=str(uuid.uuid4()),**extra))["operation"]
 async def current(op):
  return next(v for v in (await p("operations",projectId=pid))["operations"] if v["id"]==op["id"])
 async def wait(op,terminal=True):
  deadline=time.time()+100
  while time.time()<deadline:
   value=await current(op)
   if terminal and value["status"] not in ["running","queued"]:return value
   if not terminal and value["status"]=="running":return value
   if not terminal and value["status"] not in ["queued"]:raise AssertionError(("Did not observe running operation",value))
   await asyncio.sleep(.4)
  raise AssertionError(("Operation deadline",value))
 await write({"index.html":source["index.html"].replace("云端报名站","云端报名站 · 更新验收 "+secrets.token_hex(4))})
 assert site.call()[1]==baseline
 update=await wait(await enqueue("publish"));assert update["status"]=="completed",update
 new=update["result"]["versionId"];assert new!=old
 assert "更新验收".encode() in site.call()[1];persistence()
 passed("immutable-public-update-keeps-production-data",oldVersion=old,newVersion=new)
 await write({"server.ts":source["server.ts"]+"\nconst deliberateBuildFailure: = ;\n"})
 failed=await wait(await enqueue("publish"));assert failed["status"]=="failed",failed
 assert (await p("get",projectId=pid))["project"]["activeVersion"]==new
 assert "更新验收".encode() in site.call()[1];persistence()
 passed("real-failed-build-preserves-last-good-site",operationId=failed["id"])
 await write({"server.ts":source["server.ts"],"index.html":source["index.html"],"README.md":source["README.md"]+"\nCancellation acceptance "+secrets.token_hex(8)})
 cancelled=await enqueue("check");await wait(cancelled,terminal=False)
 await p("cancel",projectId=pid,operationId=cancelled["id"])
 assert (await current(cancelled))["status"]=="cancelled"
 await asyncio.sleep(2)
 assert (await p("get",projectId=pid))["project"]["activeVersion"]==new;persistence()
 passed("running-operation-cancellation-preserves-code-data-site",operationId=cancelled["id"])
 rollback=await wait(await enqueue("rollback",versionId=old));assert rollback["status"]=="completed",rollback
 assert site.call()[1]==baseline;persistence()
 passed("actual-rollback-keeps-database-and-uploads",activeVersion=old)
 print(json.dumps({"request":"restart-project-runtime","projectId":pid,"versionId":old}),flush=True)
 assert sys.stdin.readline().strip()=="continue"
 for _ in range(40):
  try:
   assert site.call()[0]==200;persistence();break
  except Exception:await asyncio.sleep(1)
 else:raise AssertionError("Recovery did not restore published application")
 assert (await p("get",projectId=pid))["project"]["activeVersion"]==old
 passed("project-service-and-published-container-restart-recovery")
 report.update({"projectId":pid,"secondProjectId":other["id"],"url":site.url,"activeVersion":old,"persistentDocumentId":doc["id"],"persistentUploadId":upload["id"]})
 print(json.dumps({"report":report},ensure_ascii=False),flush=True)
asyncio.run(main())
