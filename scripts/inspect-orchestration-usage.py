"""Read bounded accounting facts for explicitly named acceptance runs; no model calls."""
import argparse
import json
import re
import subprocess

PROGRAM = r'''
import json, sys
from database import get_db
runs = sys.argv[1:]
report = []
with get_db() as conn, conn.cursor() as cur:
    for run in runs:
        cur.execute("SELECT status,created_at FROM agent_app_model_operations WHERE run_id=%s ORDER BY created_at", (run,))
        operations = [{'status': row['status'], 'createdAt': str(row['created_at'])} for row in cur.fetchall()]
        cur.execute("SELECT model_name,tokens_request,tokens_response,is_success,error_code,usage_json FROM ai_usage_logs WHERE question_text LIKE %s AND client_type='saishi_agent_cloud' ORDER BY id", ('run='+run+';%',))
        usage = []
        for row in cur.fetchall():
            details = row.pop('usage_json', None)
            if isinstance(details, str):
                details = json.loads(details)
            details = details or {}
            usage.append({**row, 'durationMs': details.get('duration_ms'), 'operationId': details.get('operationId')})
        report.append({'runId': run, 'operations': operations, 'usage': usage})
print(json.dumps({'diagnostic': 'orchestration-usage', 'runs': report}, ensure_ascii=False))
'''

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runs', nargs='+')
    args = parser.parse_args()
    if len(args.runs) > 8 or any(not re.fullmatch(r'run_[A-Za-z0-9_-]{1,100}', run) for run in args.runs):
        parser.error('provide up to eight exact run IDs')
    result = subprocess.run(['docker','exec','-i','-w','/app','daoyintech-backend','python','-',*args.runs],
        input=PROGRAM, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
            if value.get('diagnostic') == 'orchestration-usage': print(json.dumps(value, ensure_ascii=False, indent=2))
        except (ValueError, AttributeError):
            pass
    if result.returncode: print('Accounting inspection failed; raw output withheld.')
    raise SystemExit(result.returncode)
