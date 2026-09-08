"""Small actual-model acceptance through the deployed account gateway and cloud storage.

Requires explicit --run-sample and an exact deployed revision. Reuses one uniquely
identified existing valid administrator; never creates users, changes permissions,
prints credentials, stubs a model, or fabricates business responses.
"""
import argparse
import json
from pathlib import Path
import subprocess

PROGRAM = r'''
import asyncio, json, sys, time, uuid
from database import get_db
from routes.harness_evaluation import require_global_admin
from services.first_party_accounts import validate_row
from services import agent_app_access as access
from services import saishi_agent_bridge as bridge
from routes.agent_public import cloud_request
from routes.harness_evaluation_live import gateway_usage

async def main(revision, selected):
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("""SELECT DISTINCT s.* FROM first_party_account_sessions s
            JOIN users u ON u.id=s.actor_user_id AND u.status=1
            JOIN tenant_members tm ON tm.user_id=u.id AND tm.status=1
            JOIN tenants t ON t.id=tm.tenant_id AND t.status=1
            JOIN tenant_member_roles tmr ON tmr.tenant_member_id=tm.id AND tmr.status=1
            JOIN roles r ON r.id=tmr.role_id AND r.status=1
            WHERE s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(6)
              AND r.tenant_id=0 AND r.role_key='admin' ORDER BY s.created_at DESC""")
        candidates = cur.fetchall()
        if len({str(row['actor_user_id']) for row in candidates}) != 1:
            raise RuntimeError('A unique valid administrator actor is required')
        session = None
        for row in candidates:
            try:
                checked = validate_row(cur, row)
                require_global_admin(cur, int(checked['actor_user_id']))
                session = checked
                break
            except Exception:
                continue
        if session is None: raise RuntimeError('No valid existing administrator session')
    bearer, grant = access.for_account(session)
    config = access.configured()
    async def call(method, path, body=None):
        return await cloud_request(config, bearer, method, path, body)
    actual = await call('GET', 'runtime')
    build = actual.get('build', {})
    if build.get('revision') != revision: raise RuntimeError('Deployed revision differs from requested acceptance revision')
    model = bridge.require_model_runtime().get('model_name')
    nonce = 'accept_' + uuid.uuid4().hex[:12]
    cases = {
      'handoff_business': ('必须只调用一次 workflow_run_inline，使用两个字符串步骤。第一步必须调用 saishi_list_events，只读查询当前账号能访问的前两个赛事，返回赛事ID和名称。第二步不得调用业务工具，只读取系统传入的第一步结果，整理成两行“赛事ID：名称”。父Agent根据第二步返回最终结果。全程不修改业务数据、不读写记忆。', 'workflow_run_inline', 2),
      'delegate_read': ('必须先调用 delegate_agent，委派一个子 Agent 只读查询当前账号可访问的赛事，最多两个名称；子 Agent 必须实际调用 saishi_list_events，不创建、修改、删除数据，不读写记忆。父 Agent 必须根据子 Agent 返回的真实查询结果回复。', 'delegate_agent', 1),
      'handoff': ('必须只调用一次 workflow_run_inline，用两个字符串步骤。第一步只返回验证码 '+nonce+'；第二步只读取系统传入的上一步验证码，并把验证码逐字符反转后返回。子 Agent 不调用业务工具，不读写记忆。父 Agent 汇总第二步结果。', 'workflow_run_inline', 2),
      'parallel': ('必须只调用一次 delegate_parallel，任务A仅计算6*7，任务B仅计算9*9；各子 Agent 不调用业务工具或记忆。父 Agent 按A、B输入顺序给出两个结果。', 'delegate_parallel', 2),
      'dag': ('必须只调用一次 workflow_run_inline，steps 用显式依赖对象：节点a无依赖，仅计算6*7；节点b无依赖，仅计算9*9；节点merge依赖a和b，只读取两者传入的结果并相加。节点字段为id、instruction、dependsOn。不调用业务工具或记忆，父Agent报告汇总。', 'workflow_run_inline', 3),
      'cancel': ('必须使用 delegate_parallel 启动两个子 Agent。各自只读查询当前账号可访问的赛事，实际调用 saishi_list_events，然后分别写一段500字的数据完整性检查说明。不要修改业务数据，不读写记忆。', 'delegate_parallel', 2),
    }
    reports = []
    for case_id in selected:
        prompt, tool, expected_children = cases[case_id]
        started = time.monotonic()
        created = await call('POST', 'sessions', {'title': '多 Agent 真实验收 · '+case_id})
        session_id = created['session']['id']
        request_id = 'ma_' + uuid.uuid4().hex
        item = {'case': case_id, 'sessionId': session_id, 'requestId': request_id, 'input': prompt}
        reports.append(item)
        accepted = await call('POST', 'sessions/'+session_id+'/runs', {'requestId': request_id, 'message': prompt, 'maxModelCalls': 8})
        run = accepted['run']; run_id = run['id']; item['runId'] = run_id
        cancelled = False
        deadline = time.monotonic() + 145
        while run['status'] == 'running' and time.monotonic() < deadline:
            if case_id == 'cancel' and not cancelled:
                diagnostic = await call('GET', 'runs/'+run_id+'/diagnostics')
                if any(child['status']=='running' for child in diagnostic.get('orchestration', {}).get('children', [])):
                    await call('POST', 'runs/'+run_id+'/cancel', {})
                    cancelled = True
            await asyncio.sleep(0.5)
            run = (await call('GET', 'runs/'+run_id))['run']
        if run['status'] == 'running':
            await call('POST', 'runs/'+run_id+'/cancel', {})
            raise RuntimeError('Actual run exceeded acceptance deadline; cancellation requested, not resubmitted')
        diagnostic = await call('GET', 'runs/'+run_id+'/diagnostics')
        children = diagnostic.get('orchestration', {}).get('children', [])
        # A cancellation terminal can precede final cleanup by a few milliseconds.
        for _ in range(10):
            if not any(child['status']=='running' for child in children): break
            await asyncio.sleep(0.3)
            diagnostic = await call('GET', 'runs/'+run_id+'/diagnostics')
            children = diagnostic.get('orchestration', {}).get('children', [])
        parent_events = (await call('GET', 'sessions/'+session_id+'/events'))['events']
        evidence = []
        for child in children:
            events = (await call('GET', 'sessions/'+child['sessionId']+'/events'))['events']
            first = next((event for event in events if event['type']=='turn.started'), None)
            terminal = next((event for event in reversed(events) if event['type'].startswith('turn.') and event['type']!='turn.started'), None)
            tools = [{'name': event['payload']['toolName'], 'eventId': event['id']} for event in events if event['type']=='tool.completed']
            evidence.append({**child, 'startedAt': first.get('occurredAt') if first else None,
                'endedAt': terminal.get('occurredAt') if terminal else None,
                'input': first['payload']['userMessage'] if first else '', 'completedTools': tools})
        usage = gateway_usage(grant, run_id)
        checks = {'rootTerminal': run['status']!='running', 'childrenSettled': all(child['status']!='running' for child in children),
            'separateSessions': all(child['sessionId']!=session_id for child in children) and len({child['sessionId'] for child in children})==len(children),
            'rootGatewayBudget': 0 < usage['modelCalls'] <= 8,
            'toolActuallyDispatched': any(event['type']=='tool.started' and event['payload']['toolName']==tool for event in parent_events)}
        if case_id == 'cancel':
            checks.update({'cancellationRequestedAfterChildAdmission': cancelled, 'rootCancelled': run['status']=='cancelled', 'hasChild': len(children)>0,
                'cancelNotMisclassifiedAsFailure': any(event['type']=='tool.failed' and event['payload']['toolName']==tool and event['payload']['code']=='TOOL_CANCELLED' for event in parent_events)})
        else:
            checks.update({'rootCompleted': run['status']=='completed', 'childCount': len(children)==expected_children,
                'childrenCompleted': all(child['status']=='completed' for child in children),
                'toolCompleted': any(event['type']=='tool.completed' and event['payload']['toolName']==tool for event in parent_events)})
        if case_id == 'delegate_read':
            checks['realBusinessTool'] = any(t['name']=='saishi_list_events' for child in evidence for t in child['completedTools'])
        if case_id == 'handoff_business':
            first = next((child for child in evidence if child['nodeId']=='step_1'), {})
            second = next((child for child in evidence if child['nodeId']=='step_2'), {})
            checks['realBusinessSource'] = any(tool['name']=='saishi_list_events' for tool in first.get('completedTools', []))
            checks['persistedHandoff'] = bool(first.get('runId')) and first['runId'] in second.get('input','') and 'UNTRUSTED_UPSTREAM_RESULTS' in second.get('input','')
            checks['sequentialOrder'] = bool(first.get('endedAt')) and bool(second.get('startedAt')) and first['endedAt'] <= second['startedAt']
            checks['downstreamDoesNotRequery'] = not second.get('completedTools')
        if case_id == 'handoff':
            second = next((child for child in evidence if child['nodeId']=='step_2'), {})
            first = next((child for child in evidence if child['nodeId']=='step_1'), {})
            checks['persistedHandoff'] = bool(first.get('runId')) and first['runId'] in second.get('input','') and 'UNTRUSTED_UPSTREAM_RESULTS' in second.get('input','')
            checks['reversedNonce'] = nonce[::-1] in second.get('finalText','') and nonce[::-1] in run.get('finalText','')
        if case_id in ('parallel','dag'):
            independent = [child for child in evidence if child['nodeId'] in ('step_1','step_2','a','b')]
            checks['actualOverlap'] = len(independent)==2 and all(child['startedAt'] and child['endedAt'] for child in independent) and max(child['startedAt'] for child in independent) < min(child['endedAt'] for child in independent)
            if case_id == 'dag':
                joined = next((child for child in evidence if child['nodeId']=='merge'), {})
                checks['dependencyOrder'] = len(independent)==2 and bool(joined.get('startedAt')) and all(child['endedAt'] and child['endedAt'] <= joined['startedAt'] for child in independent)
                checks['explicitDependencyHandoff'] = bool(joined) and all(child['runId'] in joined.get('input','') for child in independent)
                checks['sum123'] = '123' in joined.get('finalText','') and '123' in run.get('finalText','')
        item.update({'status': run['status'], 'answer': run.get('finalText','')[:2000], 'durationMs': round((time.monotonic()-started)*1000),
            'modelCalls': usage['modelCalls'], 'usageSource': usage['source'], 'checks': checks, 'passed': all(checks.values()), 'children': evidence,
            'parentToolFailures': [event['payload'] for event in parent_events if event['type']=='tool.failed']})
    return {'acceptance': 'cloud-orchestration-real-model', 'revision': revision, 'runtimeBuild': build, 'model': model,
        'authority': 'existing-valid-single-admin-actor', 'browserCookieFlow': 'not-tested', 'fakeModels': False,
        'cases': reports, 'passed': all(item.get('passed',False) for item in reports)}

try:
    result = asyncio.run(main(sys.argv[1], sys.argv[2].split(',')))
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['passed'] else 1)
except Exception as error:
    print(json.dumps({'acceptance': 'cloud-orchestration-real-model', 'passed': False, 'blocked': type(error).__name__,
        'reason': str(error) if isinstance(error, RuntimeError) else 'Actual service/authorization request failed; no resubmission'}, ensure_ascii=False))
    raise SystemExit(1)
'''

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-sample', action='store_true', required=True)
    parser.add_argument('--expected-revision', required=True)
    parser.add_argument('--cases', default='delegate_read,handoff_business,parallel')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    allowed = {'delegate_read', 'handoff', 'handoff_business', 'parallel', 'dag', 'cancel'}
    cases = args.cases.split(',')
    if not 1 <= len(cases) <= 5 or len(set(cases)) != len(cases) or not set(cases) <= allowed:
        parser.error('choose 1-5 distinct actual cases')
    if len(args.expected_revision) != 40 or any(char not in '0123456789abcdef' for char in args.expected_revision):
        parser.error('expected-revision must be a full Git revision')
    result = subprocess.run(['docker', 'exec', '-i', '-w', '/app', 'daoyintech-backend', 'python', '-', args.expected_revision, args.cases],
        input=PROGRAM, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=580)
    reports = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get('acceptance') == 'cloud-orchestration-real-model': reports.append(value)
        except ValueError:
            pass
    report = reports[-1] if reports else {'passed': False, 'blocked': 'No sanitized acceptance output'}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(result.returncode)
