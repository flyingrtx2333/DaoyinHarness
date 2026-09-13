
import asyncio,json,sys,time,uuid
from database import get_db
from services.first_party_accounts import validate_row
from services import agent_app_access as access
from routes.agent_public import cloud_request
async def main(mode):
 with get_db() as conn,conn.cursor() as cur:
  cur.execute("""SELECT DISTINCT s.* FROM first_party_account_sessions s
   JOIN users u ON u.id=s.actor_user_id AND u.status=1
   JOIN tenant_members tm ON tm.user_id=u.id AND tm.status=1
   JOIN tenant_member_roles tmr ON tmr.tenant_member_id=tm.id AND tmr.status=1
   JOIN roles r ON r.id=tmr.role_id AND r.status=1
   WHERE s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(6) AND r.tenant_id=0 AND r.role_key='admin'
   ORDER BY s.created_at DESC""")
  rows=cur.fetchall()
  if mode=="create":
   cur.execute("SELECT * FROM first_party_account_sessions WHERE actor_user_id=3 AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(6) ORDER BY created_at DESC LIMIT 1")
   rows=cur.fetchall()
  assert len({str(r["actor_user_id"]) for r in rows})==1,"No unique authorized administrator"
  session=validate_row(cur,rows[0])
 bearer,grant=access.for_account(session)
 config=access.configured()
 async def api(method,path,body=None):return await cloud_request(config,bearer,method,path,body)
 async def project(action,**body):return await api("POST","projects/control",{"action":action,**body})
 identity=access.identity(grant)
 state=await project("capabilities")
 projects=(await project("list"))["projects"]
 target=next(p for p in projects if p["title"]==("校园活动报名" if mode=="create" and any(v["title"]=="校园活动报名" for v in projects) else "学校账号隔离验收" if mode=="create" else "云端应用验收"))
 report={"mode":mode,"authority":"actual-authorized-test-account","projectId":target["id"],"capabilities":state,"projectTools":[t for t in identity["allowedTools"] if t.startswith("project_")],"modelCallsRequested":0}
 if mode in {"inspect","status"}:
  report["project"]=target
  report["operations"]=(await project("operations",projectId=target["id"]))["operations"][:3]
  print(json.dumps(report,ensure_ascii=False));return
 created=await api("POST","sessions",{"title":"云端开发验收 · "+mode})
 cloud_session=created["session"]
 if mode!="create" or target["title"]=="校园活动报名":await project("bind",projectId=target["id"],sessionId=cloud_session["id"])
 message=("仅使用 project_* 工具完成当前对话关联项目的开发验收。先读取当前项目文件，只把 index.html 里的网页标题改成“云端报名站”，其余文件保持不变，然后启动实际预览。不要新建项目，不要发布，不使用其他业务或记忆工具。" if mode=="iterate" else "发布当前项目")
 if mode=="create":message="请新建名为校园活动报名的网站项目，使用内置的网站用户登录、数据录入和文件上传功能，并启动真实云端预览。不要发布，只使用 project_* 工具。"
 if mode=="create" and target["title"]=="校园活动报名":message="继续当前已创建的校园活动报名项目。不修改任何文件，不要新建项目，直接调用 project_preview 启动实际预览。不要发布。"
 started=time.time()
 accepted=await api("POST","sessions/"+cloud_session["id"]+"/runs",{"requestId":str(uuid.uuid4()),"message":message})
 run=accepted["run"];report.update({"sessionId":cloud_session["id"],"runId":run["id"],"input":message,"modelCallsRequested":"bounded actual production Agent loop"})
 for _ in range(70):
  if run["status"] not in {"running","queued"}:break
  await asyncio.sleep(2)
  run=(await api("GET","runs/"+run["id"]))["run"]
 if mode=="create":target=(await project("bound",sessionId=cloud_session["id"]))["project"] or target
 events=(await api("GET","sessions/"+cloud_session["id"]+"/events?after=0"))["events"]
 report["projectId"]=target["id"]
 report.update({"runStatus":run["status"],"answer":run.get("finalText",""),"elapsedSeconds":round(time.time()-started,2),
   "tools":[{"type":e["type"],"payload":{k:v for k,v in e.get("payload",{}).items() if k in {"toolName","name","code","summary","message"}}} for e in events if e["type"].startswith("tool.")],
   "operations":(await project("operations",projectId=target["id"]))["operations"][:3],
   "project":(await project("get",projectId=target["id"]))["project"]})
 try:report["diagnostics"]=await api("GET","runs/"+run["id"]+"/diagnostics")
 except Exception:report["diagnostics"]="unavailable"
 print(json.dumps(report,ensure_ascii=False))
asyncio.run(main(sys.argv[1]))
