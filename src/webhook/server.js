'use strict';
const express = require('express');
const net     = require('net');
const { v4: uuid } = require('uuid');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const { sessions } = require('../realtime/ws-bridge');

const log = createLogger('webhook-in');

async function startWebhook(port) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── Asterisk ARI ────────────────────────────────────────────
  app.post('/webhook/:tenantId/asterisk/ari', async (req, res) => {
    const ev = req.body, tid = req.params.tenantId;
    try {
      if (ev.type === 'StasisStart') {
        const ch = ev.channel;
        await db.saveCall(tid, { call_id: ch.id, pbx:'asterisk', caller_num: ch.caller?.number, exten: ch.dialplan?.exten });
      } else if (ev.type === 'StasisEnd' || ev.type === 'ChannelHangupRequest') {
        await db.endCall(tid, ev.channel?.id, { duration_sec: ev.channel?.duration || 0 });
      }
      await db.save(db.tdb(tid,'webhooks'), { _id:'ari_'+uuid(), type:'ari_event', event:ev.type, data:ev, ts:new Date().toISOString() }).catch(()=>{});
    } catch(e) { log.warn('ARI [%s]: %s', tid, e.message); }
    res.json({ ok:true });
  });

  // ── FreeSWITCH XML-curl ──────────────────────────────────────
  app.post('/webhook/:tenantId/freeswitch/xmlcurl', async (req, res) => {
    const tid = req.params.tenantId, exten = req.body.key_value || '9000';
    if (req.body.event === 'call.started') {
      await db.saveCall(tid, { call_id: req.body.call_id || uuid(), pbx:'freeswitch', caller_num: req.body.caller, exten: req.body.exten }).catch(()=>{});
    }
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="dialplan"><context name="default">
    <extension name="techlife_ai_${tid}">
      <condition field="destination_number" expression="^${exten}$">
        <action application="set" data="techlife_tenant=${tid}"/>
        <action application="answer"/>
        <action application="socket" data="127.0.0.1:8766 async full"/>
      </condition>
    </extension>
  </context></section>
</document>`);
  });

  // ── Kamailio MI ──────────────────────────────────────────────
  app.post('/webhook/:tenantId/kamailio/mi', async (req, res) => {
    const tid = req.params.tenantId;
    await db.save(db.tdb(tid,'webhooks'), { _id:'kam_'+uuid(), type:'kamailio_event', data:req.body, ts:new Date().toISOString() }).catch(()=>{});
    res.json({ ok:true });
  });

  // ── Generic webhook (any PBX/platform) ──────────────────────
  app.post('/webhook/:tenantId/generic', async (req, res) => {
    const tid = req.params.tenantId;
    const { event, call_id, data = {}, source = 'external' } = req.body;
    log.info('Generic [%s]: event=%s source=%s', tid, event, source);
    try {
      if (event === 'call.started')  await db.saveCall(tid, { call_id: call_id || uuid(), pbx: source, ...data });
      else if (event === 'call.ended') await db.endCall(tid, call_id, data);
      else if (event === 'transcript') await db.saveTranscript(tid, { call_id, ...data });
      else if (event === 'cdr')       await db.saveCDR(tid, { call_id, ...data });
      else if (event === 'csat')      await db.saveCSAT(tid, { call_id, ...data });
    } catch(e) { log.warn('Generic event [%s]: %s', tid, e.message); }
    // Forward to live WS session
    if (call_id && sessions.has(call_id)) {
      const sess = sessions.get(call_id);
      if (sess?.ws?.readyState === 1) sess.ws.send(JSON.stringify({ type:'webhook_event', event, data }));
    }
    await db.save(db.tdb(tid,'webhooks'), { _id:'wh_'+uuid(), type:'generic_webhook', event, source, data, ts:new Date().toISOString() }).catch(()=>{});
    res.json({ ok:true, received:event });
  });

  // ── CSAT survey submission ───────────────────────────────────
  app.post('/webhook/:tenantId/csat', async (req, res) => {
    await db.saveCSAT(req.params.tenantId, req.body).catch(()=>{});
    res.json({ ok:true });
  });

  app.get('/webhook/test', (req, res) => res.json({ ok:true, endpoints: {
    asterisk_ari:   'POST /webhook/:tenantId/asterisk/ari',
    freeswitch_esl: `TCP 127.0.0.1:${process.env.ESL_PORT||8776}`,
    freeswitch_xml: 'POST /webhook/:tenantId/freeswitch/xmlcurl',
    kamailio_mi:    'POST /webhook/:tenantId/kamailio/mi',
    generic:        'POST /webhook/:tenantId/generic',
    csat:           'POST /webhook/:tenantId/csat',
  }}));

  await new Promise(r => app.listen(port, '0.0.0.0', r));

  // FreeSWITCH ESL TCP
  const eslPort = parseInt(process.env.ESL_PORT || '8776');
  startESL(eslPort);

  log.info('Webhook server on http://0.0.0.0:%d', port);
  return app;
}

function startESL(eslPort) {
  const server = net.createServer(socket => {
    log.info('FreeSWITCH ESL connected from %s', socket.remoteAddress);
    let buf = '', tenantId = null;
    socket.on('data', chunk => {
      buf += chunk.toString();
      const blocks = buf.split('\n\n'); buf = blocks.pop();
      blocks.forEach(raw => {
        if (!raw.trim()) return;
        try {
          const headers = {};
          raw.split('\n').forEach(l => { const i=l.indexOf(': '); if(i>0) headers[l.slice(0,i).trim()]=decodeURIComponent(l.slice(i+2).trim()); });
          tenantId = headers['variable_techlife_tenant'] || tenantId;
          const ev = headers['Event-Name'], callId = headers['Unique-ID']||headers['variable_uuid'];
          const caller = headers['Caller-Caller-ID-Number']||headers['variable_caller_id_number'];
          const exten = headers['Caller-Destination-Number'], dur = parseInt(headers['variable_duration']||'0');
          const ctype = headers['Content-Type'];
          if (ctype==='auth/request') { socket.write('auth ClueCon\n\n'); return; }
          if (ctype==='command/reply') { if ((headers['Reply-Text']||'').includes('+OK')) socket.write('event plain CHANNEL_ANSWER CHANNEL_HANGUP CHANNEL_BRIDGE DTMF\n\n'); return; }
          if (ev==='CHANNEL_ANSWER' && tenantId && callId) db.saveCall(tenantId, { call_id:callId, pbx:'freeswitch', caller_num:caller, exten }).catch(()=>{});
          if (ev==='CHANNEL_HANGUP' && tenantId && callId) db.endCall(tenantId, callId, { duration_sec:dur }).catch(()=>{});
        } catch {}
      });
    });
    socket.on('error', e => log.warn('ESL socket: %s', e.message));
    socket.on('close', () => log.info('ESL disconnected'));
  });
  server.listen(eslPort, '127.0.0.1', () => log.info('ESL listener on 127.0.0.1:%d', eslPort));
  server.on('error', e => log.error('ESL server: %s', e.message));
}

module.exports = { startWebhook };
