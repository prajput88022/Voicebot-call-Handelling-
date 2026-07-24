'use strict';
const { WebSocketServer, OPEN } = require('ws');
const { v4: uuid } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const ai = require('../ai/client');
const billing = require('../billing/engine');
const { fireOutboundWebhooks } = require('../webhook/outbound');
const botEngine = require('../bot/engine');

const log = createLogger('ws-bridge');
const sessions = new Map();

// ── Whisper subprocess ────────────────────────────────────────
let whisperProc = null, whisperReady = false;
const whisperQ = new Map();

function startWhisper() {
  const py = path.join(__dirname, '../../scripts/whisper_server.py');
  try {
    whisperProc = spawn(process.env.PYTHON_BIN || 'python3', [py, process.env.WHISPER_MODEL || 'medium'], { stdio: ['pipe','pipe','pipe'] });
    whisperProc.stdout.on('data', chunk => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        try {
          const msg = JSON.parse(line);
          if (msg.ready) { whisperReady = true; log.info('Whisper ready [%s]', process.env.WHISPER_MODEL||'medium'); }
          if (msg.id && whisperQ.has(msg.id)) { const { resolve } = whisperQ.get(msg.id); whisperQ.delete(msg.id); resolve({ text: msg.text||'', lang: msg.lang||'en' }); }
        } catch {}
      });
    });
    whisperProc.stderr.on('data', d => log.debug('Whisper: %s', d.toString().trim()));
    whisperProc.on('exit', code => { whisperReady = false; log.warn('Whisper exited (%d) — restarting', code); setTimeout(startWhisper, 3000); });
  } catch(e) { log.error('Whisper start: %s', e.message); }
}

async function asr(pcm) {
  if (!whisperReady || !whisperProc || pcm.length < 3200) return { text:'', lang:'en' };
  const id = uuid();
  return new Promise(resolve => {
    whisperQ.set(id, { resolve });
    whisperProc.stdin.write(JSON.stringify({ id, sampleRate:16000, bits:16 }) + '\n');
    whisperProc.stdin.write(pcm);
    whisperProc.stdin.write('\n---END---\n');
    setTimeout(() => { if (whisperQ.has(id)) { whisperQ.delete(id); resolve({ text:'', lang:'en' }); } }, 8000);
  });
}

// ── Per-call session ──────────────────────────────────────────
async function handleSession(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const tenantId  = url.searchParams.get('tenant') || url.searchParams.get('t');
  const pbxType   = url.searchParams.get('pbx')    || 'unknown';
  const callerNum = url.searchParams.get('caller')  || null;
  const exten     = url.searchParams.get('exten')   || null;

  if (!tenantId) { ws.send(JSON.stringify({ type:'error', message:'tenant param required' })); ws.close(); return; }
  const tenantDoc = await db.getTenant(tenantId).catch(() => null);
  if (!tenantDoc || tenantDoc.status !== 'active') { ws.send(JSON.stringify({ type:'error', message:'tenant inactive' })); ws.close(); return; }

  const callId = uuid();
  const t0 = Date.now();
  let history = [], callerLang = 'en', txCount = 0, audioBuf = Buffer.alloc(0);
  const CHUNK = parseInt(process.env.ASR_CHUNK_BYTES || '32000');

  await db.saveCall(tenantId, { call_id:callId, pbx:pbxType, caller_num:callerNum, exten });
  sessions.set(callId, { ws, tenantId, started:t0, pbxType, callerNum });

  ws.send(JSON.stringify({ type:'connected', call_id:callId, tenant_id:tenantId, server:'TechLife VoiceBridge Enterprise', version:'2.0.0' }));
  await fireOutboundWebhooks(tenantId, 'call.started', { call_id:callId, caller_num:callerNum, exten, pbx:pbxType });

  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        audioBuf = Buffer.concat([audioBuf, data]);
        while (audioBuf.length >= CHUNK) {
          const chunk = audioBuf.slice(0, CHUNK);
          audioBuf = audioBuf.slice(CHUNK);
          await processAudio(ws, chunk, { callId, tenantId, tenantDoc, t0,
            getHistory:()=>history, setHistory:h=>{history=h;},
            getLang:()=>callerLang, setLang:l=>{callerLang=l;},
            incTx:()=>{txCount++;},
          });
        }
      } else {
        const msg = JSON.parse(data.toString());
        await handleControl(ws, msg, { callId, tenantId, history, callerLang, t0, txCount });
        if (msg.type === 'hangup') ws.close();
      }
    } catch(e) { log.error('msg [%s]: %s', callId.slice(0,8), e.message); }
  });

  ws.on('close', async () => {
    sessions.delete(callId);
    const dur = Math.round((Date.now()-t0)/1000);
    await db.endCall(tenantId, callId, { duration_sec:dur, transcript_count:txCount });
    await db.saveCDR(tenantId, { call_id:callId, start_time:new Date(t0).toISOString(), end_time:new Date().toISOString(), duration_sec:dur, caller_num:callerNum, exten, pbx:pbxType, caller_lang:callerLang, disposition:txCount>0?'ANSWERED':'NO ANSWER', transcript_count:txCount });
    await fireOutboundWebhooks(tenantId, 'call.ended', { call_id:callId, duration_sec:dur, transcript_count:txCount, caller_lang:callerLang });
    log.info('CLOSE tenant=%s call=%s dur=%ds tx=%d', tenantId, callId.slice(0,8), dur, txCount);
  });
}

async function processAudio(ws, pcm, ctx) {
  const { callId, tenantId, tenantDoc, getHistory, setHistory, getLang, setLang, incTx } = ctx;

  const pricing   = await db.getPricing(tenantId).catch(() => null);
  const asrV      = pricing ? Object.keys(pricing.vendors?.asr||{})[0]          : 'whisper';
  const llmV      = pricing ? Object.keys(pricing.vendors?.llm||{})[0]          : 'claude_sonnet';
  const ttsV      = pricing ? Object.keys(pricing.vendors?.tts||{})[0]          : 'azure';
  const transV    = pricing ? Object.keys(pricing.vendors?.translation||{})[0]  : 'deepl';

  const t_asr = Date.now();
  const { text: transcript, lang: asrLang } = await asr(pcm);
  const asr_ms = Date.now()-t_asr;
  if (!transcript || transcript.length < 2) return;

  const { lang: detLang } = await ai.detectLanguage(transcript);
  const callerLang = asrLang || detLang || 'en';
  setLang(callerLang);

  const t_trans = Date.now();
  const { text: translated, engine: transEngine, chars: transChars } = await ai.translate(transcript, callerLang, 'en', transV);
  const trans_ms = Date.now()-t_trans;

  await db.saveTranscript(tenantId, { call_id:callId, text:transcript, translated, lang:callerLang, trans_engine:transEngine, asr_ms, trans_ms });
  incTx();

  const history = getHistory();
  history.push({ role:'user', content:`[${callerLang}]: ${transcript}` });

  const t_ai = Date.now();
  // Use VoiceBot engine (routes to Rasa/Chatwoot/Claude/GPT4o/custom depending on tenant config)
  const botResult = await botEngine.processUtterance(tenantId, callId, translated, callerLang, callerNum, { history });
  const aiReply   = botResult.response || 'How can I help you?';
  const llmUsed   = botResult.bot_type || llmV;
  const tokens_in = botResult.tokens_in || 0;
  const tokens_out= botResult.tokens_out || 0;
  const ai_ms = Date.now()-t_ai;

  // Handle escalation — warm transfer to human agent
  if (botResult.escalate && ws.readyState === OPEN) {
    ws.send(JSON.stringify({
      type: 'escalate', call_id: callId, tenant_id: tenantId,
      reason: botResult.escalate_reason, brief: botResult.escalate_brief,
      bot_type: botResult.bot_type,
    }));
    if (global.broadcastToTenant) global.broadcastToTenant(tenantId, 'bot_escalate', { call_id: callId, reason: botResult.escalate_reason, brief: botResult.escalate_brief });
  }

  history.push({ role:'assistant', content:aiReply });
  if (history.length > 20) history.splice(0, 2);
  setHistory(history);

  const t_tts = Date.now();
  const audioOut = await ai.synthesize(aiReply, 'en', ttsV);
  const tts_ms = Date.now()-t_tts;
  const total_ms = asr_ms + trans_ms + ai_ms + tts_ms;

  await billing.recordUsage(tenantId, callId, {
    asr_vendor:asrV, asr_duration_sec:pcm.length/32000,
    tts_vendor:ttsV, tts_chars:aiReply.length,
    llm_vendor:llmUsed, llm_tokens_in:tokens_in, llm_tokens_out:tokens_out,
    trans_vendor:transV, trans_chars:transChars,
  });

  const payload = { type:'result', call_id:callId, tenant_id:tenantId, transcript, translated, caller_lang:callerLang, lang_name:ai.LANG_NAMES[callerLang]||callerLang, ai_reply:aiReply, intent:botResult.intent, confidence:botResult.confidence, latency:{ asr_ms, trans_ms, ai_ms, tts_ms, total_ms }, vendors:{ asr:asrV, llm:llmUsed, tts:ttsV, translation:transEngine }, bot_type:botResult.bot_type, escalate:botResult.escalate||false, has_audio:!!audioOut };
  if (ws.readyState === OPEN) ws.send(JSON.stringify(payload));
  if (audioOut && ws.readyState === OPEN) ws.send(audioOut, { binary:true });

  await fireOutboundWebhooks(tenantId, 'transcript', { call_id:callId, transcript, translated, caller_lang:callerLang, ai_reply:aiReply });
}

async function handleControl(ws, msg, ctx) {
  const { callId, tenantId, history } = ctx;
  const send = obj => ws.readyState===OPEN && ws.send(JSON.stringify(obj));
  switch (msg.type) {
    case 'ping':
      send({ type:'pong', call_id:callId, active_calls:sessions.size, uptime:Math.round(process.uptime()) }); break;
    case 'status':
      send({ type:'status', call_id:callId, tenant_id:tenantId, duration:Math.round((Date.now()-ctx.t0)/1000), tx_count:ctx.txCount, caller_lang:ctx.callerLang, active_calls:sessions.size }); break;
    case 'agent_reply':
      history.push({ role:'assistant', content:msg.text });
      await db.saveTranscript(tenantId, { call_id:callId, type:'agent_reply', text:msg.text, lang:msg.lang||'en', agent_id:msg.agent_id });
      send({ type:'ack', call_id:callId }); break;
    case 'text': {
      const msgs = [...history, { role:'user', content:msg.text }];
      const res = await ai.callCenterRespond({ history:msgs, callerLang:msg.lang||'en', callId, tenantId });
      const audio = await ai.synthesize(res.text, 'en');
      send({ type:'text_result', call_id:callId, ai_reply:res.text, has_audio:!!audio });
      if (audio && ws.readyState===OPEN) ws.send(audio, { binary:true });
      break;
    }
    case 'hangup':
      send({ type:'bye', call_id:callId }); break;
  }
}

async function startWS(port) {
  startWhisper();
  const wss = new WebSocketServer({ port, host:'0.0.0.0' });
  wss.on('connection', handleSession);
  wss.on('error', e => log.error('WSS: %s', e.message));
  log.info('WS Bridge on ws://0.0.0.0:%d', port);
  return wss;
}

module.exports = { startWS, sessions };
