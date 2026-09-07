"""Bounded operator acceptance against deployed services, never mocked API/model data.

Uses an existing valid global-administrator session only when exactly one actor is
eligible. Does not mint credentials, create accounts, change roles, or print session
identifiers. --run-sample explicitly authorizes two real, non-destructive model tasks.
"""
import argparse
import json
import subprocess

PROGRAM = r'''
import asyncio, json, sys, time, uuid
from database import get_db
from routes.harness_evaluation import forward, require_global_admin
from services.first_party_accounts import validate_row

async def main(run_sample):
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
            raise RuntimeError('A unique active administrator is required; no account was selected')
        session = None
        for row in candidates:
            try:
                checked = validate_row(cur, row)
                require_global_admin(cur, int(checked['actor_user_id']))
                session = checked
                break
            except Exception:
                continue
        if session is None: raise RuntimeError('No currently valid administrator session')
    catalog = await forward('GET', '/catalog', session)
    report = {'catalog': {'liveAvailable': catalog.get('liveAvailable'), 'model': catalog.get('model'),
              'version': catalog.get('version'), 'scope': catalog.get('scope'), 'maxTrials': catalog.get('maxTrials')},
              'authority': 'existing-valid-single-admin-actor', 'browserCookieFlow': 'not-performed', 'modelCalls': 0}
    if not run_sample:
        print(json.dumps(report, ensure_ascii=False)); return
    if not catalog.get('liveAvailable'): raise RuntimeError('Real platform model is not available')
    spec = {'requestId': str(uuid.uuid4()), 'title': '上线验收 · 两条真实小样本', 'mode': 'live',
            'repetitions': 1, 'maxModelCalls': 4, 'maxTotalCalls': 10, 'confirmPaid': True,
            'cases': [
                {'id': 'connectivity', 'input': '不要调用业务工具，也不要读取或写入记忆。仅回复：评估链路已连通。',
                 'template': 'explore', 'expectedFacts': ['回复包含评估链路已连通'], 'approved': True},
                {'id': 'real_read', 'input': '只读查询当前账号可访问的赛事，最多返回三个赛事名称。不要创建、修改、删除业务数据，也不要写入记忆。',
                 'template': 'saishi-materials', 'expectedFacts': ['基于当前账号实际赛事查询，不编造赛事'], 'approved': True},
            ]}
    created = await forward('POST', '/runs', session, spec)
    run = created['run']; run_id = run['id']; report['experiment'] = run_id
    # Observe the same accepted experiment only; never repeat a result-uncertain POST.
    deadline = time.monotonic() + 330
    while run['status'] in ('running', 'cancelling') and time.monotonic() < deadline:
        await asyncio.sleep(2)
        run = await forward('GET', '/runs/' + run_id, session)
    if run['status'] in ('running', 'cancelling'):
        await forward('POST', '/runs/' + run_id + '/cancel', session, {})
        raise RuntimeError('Sample deadline reached; cancellation requested, no resubmission')
    result = await forward('GET', '/runs/' + run_id + '/report', session, max_bytes=8_000_000)
    report['status'] = result['status']; report['completed'] = result['completed']; report['planned'] = result['planned']
    report['modelCalls'] = result['dispatchedCalls']['agent']; report['completeEvidence'] = result['completeEvidence']
    report['trials'] = [{'case': trial['caseId'], 'runStatus': trial['runStatus'], 'verdict': trial['verdict'],
        'modelCalls': trial['modelCalls'], 'modelCallsKnown': trial.get('modelCallsKnown'),
        'tools': [{'name': tool['name'], 'status': tool['status']} for tool in trial['tools']],
        'durationMs': trial['durationMs'], 'errorCode': trial['errorCode'], 'runId': trial.get('runId'),
        'runtimeRevision': trial.get('runtimeRevision'),
        'connectivityPhraseFound': '评估链路已连通' in trial['answer'] if trial['caseId']=='connectivity' else None}
        for trial in result['trials']]
    print(json.dumps(report, ensure_ascii=False))

try:
    asyncio.run(main(sys.argv[1] == 'sample'))
except Exception as error:
    detail = getattr(error, 'detail', None)
    print(json.dumps({'status': 'blocked', 'code': detail.get('code') if isinstance(detail, dict) else type(error).__name__,
                     'reason': str(error) if isinstance(error, RuntimeError) else 'Actual service or authorization request failed'}, ensure_ascii=False))
    raise SystemExit(1)
'''

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-sample', action='store_true')
    args = parser.parse_args()
    result = subprocess.run(['docker', 'exec', '-i', '-w', '/app', 'daoyintech-backend', 'python', '-',
                             'sample' if args.run_sample else 'catalog'], input=PROGRAM, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=380)
    # Only JSON acceptance summaries are emitted; container diagnostics may include private data.
    reports = []
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
            if isinstance(item, dict) and ('catalog' in item or item.get('status') == 'blocked'): reports.append(item)
        except ValueError: pass
    print(json.dumps(reports or [{'status': 'blocked', 'reason': 'No sanitized acceptance result'}], ensure_ascii=False, indent=2))
    raise SystemExit(result.returncode)
