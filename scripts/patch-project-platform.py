from pathlib import Path
import sys
root=Path(sys.argv[1])
access=root/"services/agent_app_access.py"
s=access.read_text()
marker="# Independent Harness cloud projects"
if marker not in s:
    s += '\n\n'+marker+'\n_project_base_identity = identity\ndef identity(row):\n    from services.harness_projects import extend_identity\n    return extend_identity(_project_base_identity(row), row)\n'
    access.write_text(s)
bridge=root/"services/saishi_agent_bridge.py"
s=bridge.read_text()
needle='    definitions = {tool["name"]: tool for tool in catalog["tools"]}'
if "project_definitions" not in s:
    assert needle in s
    s=s.replace(needle,needle+'\n    from services.harness_projects import definitions as project_definitions\n    definitions.update(project_definitions(grant))',1)
# Both source and live runtime have their own argument validators; append a project-specific branch to the live local validator.
if "def validate_model_arguments" in s and "validate_project_arguments" not in s:
    needle='    def validate_model_arguments(name: str, arguments: object) -> dict:\n'
    assert needle in s
    s=s.replace(needle,needle+'        if name.startswith("project_"):\n            from services.harness_projects import validate as validate_project_arguments\n            return validate_project_arguments(name, arguments, grant)\n',1)
bridge.write_text(s)
routes=root/"routes/agent_apps.py"
s=routes.read_text()
if '"/workbench/projects/control"' not in s:
    s += """
\n\n@router.post("/workbench/projects/control")
async def project_control(payload: dict, auth=Depends(browser)):
    # Browser identity, exact Origin and CSRF use the existing first-party BFF.
    if len(str(payload)) > 500000:
        raise access.fail(413,"PROJECT_REQUEST_TOO_LARGE","项目请求过大。")
    return await cloud_request(*auth, "POST", "projects/control", payload)
"""
    routes.write_text(s)

# Account-only project pilot: retain actual tenant membership, remove unrelated app subscription dependency.
s=access.read_text()
if "project_only = require_account_access" not in s:
    needle='        require_access(cur, int(row["actor_user_id"]), int(row["tenant_id"]), first_party=True)'
    assert needle in s
    s=s.replace(needle,'        from services.harness_projects import require_account_access\n        project_only = require_account_access(cur, int(row["actor_user_id"]), int(row["tenant_id"]))\n        if project_only:\n            return {**row, "event_ids": [], "scopes": [], "access_mode":"account", "workbench_scopes": [], "project_only":True}',1)
    needle='        require_access(cur, uid, tenant_id, first_party=True)'
    assert needle in s
    s=s.replace(needle,'        from services.harness_projects import require_account_access\n        require_account_access(cur, uid, tenant_id)',1)
    needle='    return extend_identity(_project_base_identity(row), row)'
    assert needle in s
    s=s.replace(needle,'    value = _project_base_identity(row)\n    if row.get("project_only"):\n        value={**value,"allowedTools":[],"permissions":["agent.use"],"appInstallationId":f"daoyin-workbench:{row[\'tenant_id\']}:independent-projects-v1"}\n    return extend_identity(value, row)')
    access.write_text(s)

# Version the project-only installation boundary independently from all business catalogs.
s=access.read_text()
s=s.replace('f"daoyin-workbench:{row[\'tenant_id\']}:independent-projects-v1"', 'f"daoyin-projects:{row[\'tenant_id\']}:{digest(\'independent-project-account-v1\')[:24]}"')
access.write_text(s)
