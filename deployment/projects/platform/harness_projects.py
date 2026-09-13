"""Independent Harness project admission and fixed model-tool schemas."""
import json
import os
import re
from pathlib import Path
from fastapi import HTTPException

def permitted(grant):
    if grant.get("access_mode") != "account" or not grant.get("model_enabled"):
        return False
    try:
        config=json.loads(Path(__file__).with_name("harness_project_admission.json").read_text())
    except (OSError,ValueError):
        config={}
    allowed={str(v) for v in config.get("allowedUsers",[])}
    allowed.update(v for v in os.getenv("HARNESS_PROJECTS_ALLOWED_USERS","").split(",") if v)
    return str(grant.get("actor_user_id")) in allowed or os.getenv("HARNESS_PROJECTS_ENABLED")=="1"

def definitions(grant):
    if not permitted(grant): return {}
    entries=json.loads(Path(__file__).with_name("harness_project_tools.json").read_text())
    return {d["name"]:d for d in entries}

def extend_identity(value,grant):
    if permitted(grant):
        value={**value,"allowedTools":list(dict.fromkeys([*value["allowedTools"],*definitions(grant)]))}
    return value

def validate(name,value,grant):
    definition=definitions(grant).get(name)
    if not definition: raise HTTPException(403,{"code":"PROJECT_TOOL_DENIED","message":"当前账号尚未开放云端开发。"})
    def check(schema,value):
        kind=schema.get("type")
        if kind=="object":
            assert type(value) is dict
            props=schema.get("properties",{})
            assert set(schema.get("required",[])) <= value.keys()
            assert schema.get("additionalProperties") is not False or set(value)<=set(props)
            for key,item in value.items():
                if key in props:check(props[key],item)
        elif kind=="array":
            assert type(value) is list and schema.get("minItems",0)<=len(value)<=schema.get("maxItems",100)
            for item in value:check(schema["items"],item)
        elif kind=="string":
            assert type(value) is str and schema.get("minLength",0)<=len(value)<=schema.get("maxLength",200000)
            if "pattern" in schema:assert re.search(schema["pattern"],value)
        elif kind=="integer":
            assert type(value) is int and schema.get("minimum",-9007199254740991)<=value<=schema.get("maximum",9007199254740991)
        if "enum" in schema: assert value in schema["enum"]
    try:check(definition["inputSchema"],value)
    except (AssertionError,KeyError,TypeError):
        raise HTTPException(400,{"code":"PROJECT_TOOL_INPUT_INVALID","message":"云端项目参数无效。"}) from None
    return value


def require_account_access(cur, uid, tenant_id):
    """Project pilot membership does not depend on buying an unrelated business app."""
    from services.agent_app_access import require_access
    try:
        require_access(cur, uid, tenant_id, first_party=True)
        return False
    except HTTPException as exc:
        if exc.status_code != 403 or not permitted({"access_mode":"account","model_enabled":True,"actor_user_id":uid}):
            raise
    cur.execute("""SELECT tm.id FROM tenant_members tm
        JOIN tenants t ON t.id=tm.tenant_id AND t.status=1
        JOIN users u ON u.id=tm.user_id AND u.status=1
        WHERE tm.tenant_id=%s AND tm.user_id=%s AND tm.status=1 LIMIT 1""",(tenant_id,uid))
    if not cur.fetchone():
        raise HTTPException(403,{"code":"HARNESS_MEMBERSHIP_REQUIRED","message":"账号不属于当前有效空间。"})
    return True
