'use strict';
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const log = createLogger('billing');
const accum = new Map();

async function initBilling() {
  setInterval(flushAll, 60000);
  log.info('Billing engine ready');
}

async function calcCost(tenantId, type, vendor, quantity, unit) {
  const pricing = await db.getPricing(tenantId);
  if (!pricing) return 0;
  const p = pricing.vendors?.[type]?.[vendor];
  if (!p) return 0;
  let cost = 0;
  if (unit==='minutes')    cost = (p.per_minute||0) * quantity;
  else if (unit==='chars') cost = (p.per_char||0)   * quantity;
  else if (unit==='tokens_in')  cost = (p.per_1k_in ||0) * quantity / 1000;
  else if (unit==='tokens_out') cost = (p.per_1k_out||0) * quantity / 1000;
  return cost * (1 + (pricing.markup_percent||0) / 100);
}

async function recordUsage(tenantId, callId, usage) {
  const { asr_vendor, asr_duration_sec, tts_vendor, tts_chars, llm_vendor, llm_tokens_in, llm_tokens_out, trans_vendor, trans_chars } = usage;
  let total_cost = 0;
  const breakdown = {};
  if (asr_vendor && asr_duration_sec) { const c = await calcCost(tenantId,'asr',asr_vendor,asr_duration_sec/60,'minutes'); breakdown.asr={vendor:asr_vendor,cost:c}; total_cost+=c; }
  if (tts_vendor && tts_chars)        { const c = await calcCost(tenantId,'tts',tts_vendor,tts_chars,'chars');             breakdown.tts={vendor:tts_vendor,cost:c}; total_cost+=c; }
  if (llm_vendor && (llm_tokens_in||llm_tokens_out)) {
    const ci = await calcCost(tenantId,'llm',llm_vendor,llm_tokens_in||0,'tokens_in');
    const co = await calcCost(tenantId,'llm',llm_vendor,llm_tokens_out||0,'tokens_out');
    breakdown.llm = { vendor:llm_vendor, cost:ci+co }; total_cost+=ci+co;
  }
  if (trans_vendor && trans_chars) { const c = await calcCost(tenantId,'translation',trans_vendor,trans_chars,'chars'); breakdown.translation={vendor:trans_vendor,cost:c}; total_cost+=c; }

  if (!accum.has(tenantId)) accum.set(tenantId, { total_cost:0, queries:0 });
  const acc = accum.get(tenantId);
  acc.total_cost += total_cost; acc.queries++;

  await db.saveBilling(tenantId, { call_id:callId, breakdown, total_cost, month:new Date().toISOString().slice(0,7) });
  return { total_cost, breakdown };
}

async function flushAll() {
  for (const [tenantId, acc] of accum.entries()) {
    if (!acc.queries) continue;
    try {
      const month = new Date().toISOString().slice(0,7);
      const existing = await db.findDocs(db.tdb(tenantId,'billing'), { type:'monthly_summary', month }, null, 1);
      if (existing.length) {
        await db.update(db.tdb(tenantId,'billing'), existing[0]._id, { total_cost:(existing[0].total_cost||0)+acc.total_cost, total_queries:(existing[0].total_queries||0)+acc.queries });
      } else {
        await db.save(db.tdb(tenantId,'billing'), { _id:`monthly_${tenantId}_${month}`, type:'monthly_summary', tenant_id:tenantId, month, total_cost:acc.total_cost, total_queries:acc.queries, created_at:new Date().toISOString() });
      }
      accum.set(tenantId, { total_cost:0, queries:0 });
    } catch (e) { log.error('flush [%s]: %s', tenantId, e.message); }
  }
}

async function getMonthlyBilling(tenantId, month) {
  const m = month || new Date().toISOString().slice(0,7);
  const records = await db.findDocs(db.tdb(tenantId,'billing'), { type:'billing_record', month:m }, null, 5000);
  const summary = { month:m, tenant_id:tenantId, total_cost:0, total_queries:0, by_vendor:{asr:{},tts:{},llm:{},translation:{}}, daily:{} };
  for (const r of records) {
    summary.total_cost += r.total_cost||0;
    summary.total_queries++;
    const day = (r.ts||'').slice(0,10);
    summary.daily[day] = (summary.daily[day]||0) + (r.total_cost||0);
    for (const [type,bd] of Object.entries(r.breakdown||{})) {
      if (!summary.by_vendor[type]) summary.by_vendor[type] = {};
      const v = bd.vendor;
      if (!summary.by_vendor[type][v]) summary.by_vendor[type][v] = { cost:0, count:0 };
      summary.by_vendor[type][v].cost  += bd.cost||0;
      summary.by_vendor[type][v].count++;
    }
  }
  return summary;
}

module.exports = { initBilling, recordUsage, calcCost, getMonthlyBilling, flushAll };
