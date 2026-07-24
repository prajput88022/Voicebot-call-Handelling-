#!/usr/bin/env python3
"""TechLife VoiceBridge — Whisper ASR subprocess"""
import sys, json, time, signal
import numpy as np

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'medium'

def main():
    import whisper
    model = whisper.load_model(MODEL)
    print(json.dumps({'ready': True, 'model': MODEL}), flush=True)
    buf, req_id = b'', None
    for line in sys.stdin:
        line = line.rstrip('\n')
        if not line:
            continue
        if line == '---END---':
            if req_id and buf:
                try:
                    t0 = time.time()
                    audio = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
                    if len(audio) >= 1600:
                        r = model.transcribe(audio, fp16=False)
                        print(json.dumps({'id': req_id, 'text': r.get('text', '').strip(), 'lang': r.get('language', 'en'), 'ms': round((time.time()-t0)*1000)}), flush=True)
                    else:
                        print(json.dumps({'id': req_id, 'text': '', 'lang': 'en'}), flush=True)
                except Exception as e:
                    print(json.dumps({'id': req_id, 'text': '', 'lang': 'en', 'error': str(e)}), flush=True)
            buf, req_id = b'', None
        else:
            try:
                meta = json.loads(line)
                req_id = meta.get('id')
                buf = b''
            except:
                buf += line.encode('latin-1', errors='replace')

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
