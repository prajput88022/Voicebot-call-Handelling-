#!/usr/bin/env python3
"""TechLife VoiceBridge — Asterisk AGI Script"""
import sys, os, json, time, urllib.request

API_URL = os.getenv('VOICEBRIDGE_API', 'http://127.0.0.1:4000')
WH_URL  = os.getenv('VOICEBRIDGE_WH',  'http://127.0.0.1:5000')

def agi_cmd(cmd):
    sys.stdout.write(cmd + '\n'); sys.stdout.flush()
    return sys.stdin.readline().strip()

def read_env():
    env = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line: break
        if ':' in line:
            k, v = line.split(':', 1)
            env[k.strip()] = v.strip()
    return env

def post(url, data):
    try:
        body = json.dumps(data).encode()
        req  = urllib.request.Request(url, data=body, headers={'Content-Type':'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except Exception as e:
        return {'error': str(e)}

def main():
    env    = read_env()
    args   = sys.argv[1:]
    mode   = args[0] if len(args)>0 else 'inbound'
    exten  = args[1] if len(args)>1 else 'unknown'
    caller = args[2] if len(args)>2 else 'unknown'
    tenant = args[3] if len(args)>3 else os.getenv('TECHLIFE_TENANT','')
    call_id = env.get('agi_uniqueid', f'ast_{int(time.time())}')

    agi_cmd('SET VARIABLE CHANNEL(audioreadformat) slin16')
    agi_cmd('SET VARIABLE CHANNEL(audiowriteformat) slin16')
    agi_cmd(f'VERBOSE "TechLife AGI mode={mode} tenant={tenant}" 1')

    if not tenant:
        agi_cmd('VERBOSE "ERROR: no tenant set in pjsip.conf set_var" 1')
        return

    post(f'{API_URL}/api/tenant/{tenant}/calls/incoming', {'call_id':call_id,'caller':caller,'exten':exten,'pbx':'asterisk'})
    post(f'{WH_URL}/webhook/{tenant}/asterisk/ari', {'type':'StasisStart','channel':{'id':call_id,'caller':{'number':caller},'dialplan':{'exten':exten}}})

    if mode == 'ai_agent':
        agi_cmd('EXEC Playback "beep"')
        agi_cmd('WAIT FOR DIGIT 300000')
    else:
        agi_cmd('EXEC Dial Local/9000@techlife-inbound')

if __name__ == '__main__':
    main()
