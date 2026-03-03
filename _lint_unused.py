import json, sys
data = json.loads(sys.stdin.read())
for f in data:
    msgs = [m for m in f['messages'] if m['ruleId'] == '@typescript-eslint/no-unused-vars']
    if msgs:
        p = f['filePath'].replace('D:\\echoagent\\projects\\AgentForge\\', '')
        for m in msgs:
            line = m['line']
            msg = m['message']
            print(f"{p}:{line}  {msg}")
