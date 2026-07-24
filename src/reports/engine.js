'use strict';
const db = require('../db/couch');
const { getMonthlyBilling } = require('../billing/engine');
const { createLogger } = require('../core/logger');
const log = createLogger('reports');

async function getCDR(tenantId, from, to, filters = {}) {
  const all = await db.findDocs(db.tdb(tenantId,'cdr'), { type:'cdr', tenant_id:tenantId, ...(filters.agent_id?{agent_id:filters.agent_id}:{}), ...(filters.queue?{queue:filters.queue}:{}) }, null, 10000);
  const inRange = all.filter(r => { const t=r.start_time||r.recorded_at||''; return (!from||t>=from)&&(!to||t<=to+'Z'); });
  const summary = { total_calls:inRange.length, answered:0, missed:0, abandoned:0, avg_duration_sec:0, avg_wait_sec:0, total_duration_sec:0, by_agent:{}, by_queue:{}, by_hour:{}, by_lang:{} };
  let durSum=0,waitSum=0,durCnt=0,waitCnt=0;
  for (const r of inRange) {
    if (r.disposition==='ANSWERED') summary.answered++;
    else if (r.disposition==='NO ANSWER') summary.missed++;
    else if (r.disposition==='ABANDONED') summary.abandoned++;
    if (r.duration_sec) { durSum+=r.duration_sec; durCnt++; }
    if (r.wait_sec)     { waitSum+=r.wait_sec;     waitCnt++; }
    if (r.agent_id) { summary.by_agent[r.agent_id]=summary.by_agent[r.agent_id]||{calls:0,duration:0,missed:0}; summary.by_agent[r.agent_id].calls++; summary.by_agent[r.agent_id].duration+=r.duration_sec||0; if(r.disposition!=='ANSWERED') summary.by_agent[r.agent_id].missed++; }
    if (r.queue)    { summary.by_queue[r.queue]=summary.by_queue[r.queue]||{calls:0,total_wait:0}; summary.by_queue[r.queue].calls++; summary.by_queue[r.queue].total_wait+=r.wait_sec||0; }
    const h = (r.start_time||'').slice(11,13)||'00';
    summary.by_hour[h] = (summary.by_hour[h]||0)+1;
    if (r.caller_lang) summary.by_lang[r.caller_lang] = (summary.by_lang[r.caller_lang]||0)+1;
  }
  summary.total_duration_sec = durSum;
  summary.avg_duration_sec   = durCnt  ? Math.round(durSum/durCnt)  : 0;
  summary.avg_wait_sec       = waitCnt ? Math.round(waitSum/waitCnt): 0;
  summary.answer_rate_pct    = inRange.length ? Math.round(summary.answered/inRange.length*100) : 0;
  summary.abandon_rate_pct   = inRange.length ? Math.round(summary.abandoned/inRange.length*100): 0;
  for (const q of Object.values(summary.by_queue)) q.avg_wait = q.calls ? Math.round(q.total_wait/q.calls) : 0;
  return { summary, records: inRange };
}

async function getACDReport(tenantId, from, to) {
  const { summary, records } = await getCDR(tenantId, from, to);
  const sla_met = records.filter(r=>r.disposition==='ANSWERED'&&(r.wait_sec||0)<=20).length;
  return { period:{from,to}, ...summary, sla_pct:summary.answered?Math.round(sla_met/summary.answered*100):0 };
}

async function getCSATReport(tenantId, from, to) {
  const all = await db.findDocs(db.tdb(tenantId,'csat'), { type:'csat', tenant_id:tenantId }, null, 10000);
  const inRange = all.filter(r=>{ const t=r.ts||''; return(!from||t>=from)&&(!to||t<=to+'Z'); });
  const total=inRange.length, sumR=inRange.reduce((s,r)=>s+(r.rating||0),0);
  const by_rating={1:0,2:0,3:0,4:0,5:0}, by_agent={};
  for (const r of inRange) { by_rating[Math.round(r.rating)]=(by_rating[Math.round(r.rating)]||0)+1; if(r.agent_id){by_agent[r.agent_id]=by_agent[r.agent_id]||{count:0,sum:0};by_agent[r.agent_id].count++;by_agent[r.agent_id].sum+=r.rating||0;} }
  for (const a of Object.values(by_agent)) a.avg=a.count?+(a.sum/a.count).toFixed(2):0;
  const promoters=inRange.filter(r=>r.rating>=4).length, detractors=inRange.filter(r=>r.rating<=2).length;
  return { period:{from,to}, total_responses:total, avg_rating:total?+(sumR/total).toFixed(2):0, nps:total?Math.round((promoters-detractors)/total*100):0, promoters, detractors, passives:total-promoters-detractors, by_rating, by_agent };
}

async function getQueueReport(tenantId, from, to) {
  const { summary } = await getCDR(tenantId, from, to);
  return { period:{from,to}, total_queues:Object.keys(summary.by_queue).length, queues:Object.entries(summary.by_queue).map(([name,d])=>({queue:name,...d})), overall_avg_wait:summary.avg_wait_sec };
}

async function getAgentReport(tenantId, from, to) {
  const { summary } = await getCDR(tenantId, from, to);
  const csat = await getCSATReport(tenantId, from, to);
  const agents = Object.entries(summary.by_agent).map(([agentId,data])=>({ agent_id:agentId, total_calls:data.calls, total_duration:data.duration, avg_duration:data.calls?Math.round(data.duration/data.calls):0, missed_calls:data.missed, answer_rate_pct:data.calls?Math.round((data.calls-data.missed)/data.calls*100):0, csat_avg:csat.by_agent[agentId]?.avg||null, csat_responses:csat.by_agent[agentId]?.count||0 }));
  agents.sort((a,b)=>b.total_calls-a.total_calls);
  return { period:{from,to}, agents };
}

async function getBillingReport(tenantId, month) { return getMonthlyBilling(tenantId, month); }

async function getDashboardSummary(tenantId) {
  const today = new Date().toISOString().slice(0,10);
  const month = new Date().toISOString().slice(0,7);
  const [cdr, csat, billing] = await Promise.all([
    getCDR(tenantId, today, today).catch(()=>({summary:{}})),
    getCSATReport(tenantId, month+'-01', today).catch(()=>({})),
    getMonthlyBilling(tenantId, month).catch(()=>({total_cost:0,total_queries:0})),
  ]);
  let activeCalls=0;
  try { activeCalls=(await db.viewQuery(db.tdb(tenantId,'calls'),'idx','active',{key:tenantId})).length; } catch {}
  return { tenant_id:tenantId, ts:new Date().toISOString(), active_calls:activeCalls,
    today:{ total_calls:cdr.summary.total_calls||0, answered:cdr.summary.answered||0, missed:cdr.summary.missed||0, avg_duration:cdr.summary.avg_duration_sec||0, avg_wait:cdr.summary.avg_wait_sec||0, answer_rate:cdr.summary.answer_rate_pct||0 },
    month:{ csat_avg:csat.avg_rating||0, nps:csat.nps||0, billing_cost:billing.total_cost||0, billing_queries:billing.total_queries||0 },
    by_lang:cdr.summary.by_lang||{}, by_hour:cdr.summary.by_hour||{} };
}

function toCSV(records, fields) {
  if (!records.length) return '';
  const cols = fields || Object.keys(records[0]);
  return [cols.join(','), ...records.map(r=>cols.map(c=>{ const v=r[c]; if(v===null||v===undefined)return''; if(typeof v==='string'&&v.includes(','))return`"${v}"`; return v; }).join(','))].join('\n');
}

async function deliverReport(tenantId, data, delivery) {
  const { type, url, headers={}, email } = delivery;
  if (type==='webhook' && url) {
    try { await require('axios').post(url, data, { headers, timeout:10000 }); log.info('Report via webhook → %s', url); } catch(e){ log.error('Webhook: %s', e.message); }
  }
  if (type==='email' && email) {
    try {
      const nodemailer = require('nodemailer');
      const tr = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:process.env.SMTP_PORT||587, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
      await tr.sendMail({ from:process.env.SMTP_FROM||'noreply@techlife.ai', to:email, subject:`VoiceBridge Report — ${data.period?.from||new Date().toISOString().slice(0,10)}`, text:JSON.stringify(data,null,2) });
      log.info('Report emailed → %s', email);
    } catch(e){ log.error('Email: %s', e.message); }
  }
}

module.exports = { getCDR, getACDReport, getCSATReport, getQueueReport, getAgentReport, getBillingReport, getDashboardSummary, toCSV, deliverReport };
