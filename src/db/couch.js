'use strict';
const nano = require('nano');
const { v4: uuid } = require('uuid');
const { createLogger } = require('../core/logger');
const log = createLogger('couchdb');

const COUCH_URL = process.env.COUCH_URL || 'http://admin:password@127.0.0.1:5984';
let client;

const GLOBAL_DBS = ['vb_tenants','vb_superadmins','vb_audit','vb_global_billing'];
const TENANT_DBS = ['calls','transcripts','billing','cdr','csat','agents','orders','webhooks','config','queues'];

const G = {};      // global DB handles
const T = {};      // T[tenantId][dbName]

const DESIGNS = {
  calls: { _id:'_design/idx', views: {
    active:    { map:"function(d){if(d.status==='active')emit(d.tenant_id,d);}" },
    by_tenant: { map:"function(d){if(d.tenant_id)emit(d.tenant_id,d);}" },
    by_date:   { map:"function(d){if(d.started)emit([d.tenant_id,d.started],d);}" },
    by_lang:   { map:"function(d){if(d.caller_lang)emit([d.tenant_id,d.caller_lang],1);}",reduce:"_count" },
  }},
  cdr: { _id:'_design/idx', views: {
    by_tenant: { map:"function(d){if(d.tenant_id)emit(d.tenant_id,d);}" },
    by_agent:  { map:"function(d){if(d.agent_id)emit([d.tenant_id,d.agent_id],d);}" },
    answered:  { map:"function(d){if(d.disposition==='ANSWERED')emit(d.tenant_id,1);}",reduce:"_count" },
  }},
  csat: { _id:'_design/idx', views: {
    by_tenant: { map:"function(d){if(d.rating)emit(d.tenant_id,d.rating);}",reduce:"_avg" },
    by_agent:  { map:"function(d){if(d.agent_id&&d.rating)emit([d.tenant_id,d.agent_id],d.rating);}",reduce:"_avg" },
  }},
  billing: { _id:'_design/idx', views: {
    by_month:  { map:"function(d){if(d.month)emit([d.tenant_id,d.month],d);}" },
    cost_sum:  { map:"function(d){if(d.total_cost)emit(d.tenant_id,d.total_cost);}",reduce:"_sum" },
  }},
};

async function initCouchDB() {
  client = nano(COUCH_URL);
  await client.info().catch(e => {
    // Surface the REAL underlying error (ECONNREFUSED, 401 unauthorized, DNS failure, etc.)
    // instead of a generic message, so connection/credential problems are easy to diagnose.
    const safeUrl = COUCH_URL.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
    throw new Error(`CouchDB unreachable at ${safeUrl} — ${e.message}`);
  });

  for (const name of GLOBAL_DBS) {
    try { await client.db.create(name); } catch (e) { if (e.statusCode !== 412) log.warn('DB %s: %s', name, e.message); }
    G[name] = client.use(name);
  }

  const tenants = await listAllDocs('vb_tenants').catch(() => []);
  for (const t of tenants.filter(d => d && d.type === 'tenant')) {
    await openTenantDBs(t._id).catch(e => log.warn('Open tenant DBs [%s]: %s', t._id, e.message));
  }
  log.info('CouchDB ready — %d global, %d tenants', GLOBAL_DBS.length, Object.keys(T).length);
}

async function openTenantDBs(tenantId) {
  T[tenantId] = {};
  for (const name of TENANT_DBS) {
    const dbName = `vb_${tenantId}_${name}`;
    try { await client.db.create(dbName); } catch (e) { if (e.statusCode !== 412) log.warn('Tenant DB %s: %s', dbName, e.message); }
    T[tenantId][name] = client.use(dbName);
    if (DESIGNS[name]) {
      try {
        const ex = await T[tenantId][name].get(DESIGNS[name]._id).catch(() => null);
        await T[tenantId][name].insert(ex ? { ...DESIGNS[name], _rev: ex._rev } : DESIGNS[name]);
      } catch {}
    }
  }
}

function tdb(tenantId, dbName) {
  if (!T[tenantId]) throw new Error(`Tenant not found: ${tenantId}`);
  if (!T[tenantId][dbName]) throw new Error(`DB not found: ${tenantId}/${dbName}`);
  return T[tenantId][dbName];
}

async function save(db, doc) {
  try { const r = await db.insert(doc); return { id: r.id, rev: r.rev }; }
  catch (e) { log.error('save: %s', e.message); return null; }
}
async function get(db, id) { try { return await db.get(id); } catch (e) { if (e.statusCode !== 404) log.error('get [%s]: %s', id, e.message); return null; } }
async function update(db, id, updates) {
  try { const doc = await db.get(id); return await db.insert({ ...doc, ...updates, updated_at: new Date().toISOString() }); }
  catch (e) { log.error('update [%s]: %s', id, e.message); return null; }
}
async function listAllDocs(dbNameOrHandle, params = {}) {
  try {
    const db = typeof dbNameOrHandle === 'string' ? G[dbNameOrHandle] : dbNameOrHandle;
    if (!db) throw new Error(`DB handle not initialized (was initCouchDB() run successfully?)`);
    const r = await db.list({ include_docs: true, ...params });
    return r.rows.map(x => x.doc).filter(Boolean);
  } catch (e) { log.error('listAllDocs: %s', e.message); return []; }
}
async function viewQuery(db, design, view, params = {}) {
  try { return (await db.view(design, view, params)).rows; } catch (e) { log.error('viewQuery [%s/%s]: %s', design, view, e.message); return []; }
}
async function findDocs(db, selector, fields = null, limit = 100) {
  try {
    if (!db) throw new Error(`DB handle not initialized (was initCouchDB() run successfully?)`);
    const q = { selector, limit }; if (fields) q.fields = fields; return (await db.find(q)).docs;
  } catch (e) { log.error('findDocs %j: %s', selector, e.message); return []; }
}

// Tenant CRUD
async function createTenant(data) {
  const id = data.id || uuid().replace(/-/g,'').slice(0,16);
  const doc = {
    _id: id, type: 'tenant', name: data.name, slug: data.slug || id,
    email: data.email, plan: data.plan || 'starter', status: 'active',
    created_at: new Date().toISOString(),
    settings: { timezone: 'UTC', currency: 'USD', languages: data.languages || ['en'],
                 default_asr: data.asr || 'whisper', default_tts: data.tts || 'azure',
                 default_llm: data.llm || 'claude_sonnet', default_translation: data.trans || 'deepl' },
    pbx: { type: null, host: null, port: null },
    webhook_out: [], crm_integration: null,
    features: {
      bot_enabled:           data.bot_enabled           !== false,
      inbound_bot:           data.inbound_bot           !== false,
      outbound_bot:          data.outbound_bot           || false,
      bot_rasa:              data.bot_rasa               || false,
      bot_chatwoot:          data.bot_chatwoot           || false,
      bot_dialogflow:        data.bot_dialogflow         || false,
      bot_watson:            data.bot_watson             || false,
      bot_lex:               data.bot_lex                || false,
      bot_botframework:      data.bot_botframework       || false,
      bot_gpt4o:             data.bot_gpt4o              || false,
      bot_claude:            true,   // always available
      bot_custom:            data.bot_custom             || false,
    },
  };
  await save(G['vb_tenants'], doc);
  await openTenantDBs(id);
  // Default pricing config
  await save(tdb(id,'config'), {
    _id: 'pricing', type: 'pricing', tenant_id: id, markup_percent: 20,
    updated_at: new Date().toISOString(),
    vendors: {
      asr: {
        whisper:   { per_minute: 0.000,  label: 'Whisper (local)' },
        deepgram:  { per_minute: 0.0043, label: 'Deepgram Nova' },
        azure:     { per_minute: 0.0100, label: 'Azure Speech' },
        google:    { per_minute: 0.0060, label: 'Google STT' },
        ibm:       { per_minute: 0.0100, label: 'IBM Watson STT' },
        openai:    { per_minute: 0.0060, label: 'OpenAI Whisper API' },
      },
      tts: {
        azure:      { per_char: 0.000016, label: 'Azure Neural TTS' },
        elevenlabs: { per_char: 0.000180, label: 'ElevenLabs' },
        google:     { per_char: 0.000016, label: 'Google WaveNet' },
        ibm:        { per_char: 0.000020, label: 'IBM Watson TTS' },
        openai:     { per_char: 0.000030, label: 'OpenAI TTS' },
        espeak:     { per_char: 0.000000, label: 'eSpeak (free)' },
      },
      llm: {
        claude_sonnet: { per_1k_in: 0.003,   per_1k_out: 0.015,   label: 'Claude Sonnet 4' },
        claude_haiku:  { per_1k_in: 0.00025, per_1k_out: 0.00125, label: 'Claude Haiku' },
        gpt4o:         { per_1k_in: 0.005,   per_1k_out: 0.015,   label: 'GPT-4o' },
        gpt4o_mini:    { per_1k_in: 0.00015, per_1k_out: 0.0006,  label: 'GPT-4o Mini' },
        deepseek:      { per_1k_in: 0.00014, per_1k_out: 0.00028, label: 'DeepSeek Chat' },
        ibm_wx:        { per_1k_in: 0.002,   per_1k_out: 0.008,   label: 'IBM Watsonx' },
      },
      translation: {
        deepl:          { per_char: 0.0000050, label: 'DeepL' },
        azure:          { per_char: 0.0000100, label: 'Azure Translator' },
        google:         { per_char: 0.0000200, label: 'Google Translate' },
        libretranslate: { per_char: 0.0000000, label: 'LibreTranslate (free)' },
        openai:         { per_char: 0.0000150, label: 'OpenAI GPT Translation' },
      },
    }
  });
  log.info('Tenant created: %s (%s)', data.name, id);
  return id;
}

async function getTenant(id) { return get(G['vb_tenants'], id); }
async function updateTenant(id, updates) { return update(G['vb_tenants'], id, updates); }
async function listTenants() { return (await listAllDocs('vb_tenants')).filter(d => d && d.type === 'tenant'); }

// Call ops
async function saveCall(tenantId, data) {
  return save(tdb(tenantId,'calls'), { _id: data.call_id || uuid(), type:'call', tenant_id:tenantId, status:'active', started:new Date().toISOString(), ...data });
}
async function endCall(tenantId, callId, extra = {}) {
  return update(tdb(tenantId,'calls'), callId, { status:'ended', ended:new Date().toISOString(), ...extra });
}
async function saveTranscript(tenantId, data) {
  return save(tdb(tenantId,'transcripts'), { _id:'tx_'+uuid(), type:'transcript', tenant_id:tenantId, ts:new Date().toISOString(), ...data });
}
async function saveCDR(tenantId, data) {
  return save(tdb(tenantId,'cdr'), { _id:'cdr_'+uuid(), type:'cdr', tenant_id:tenantId, recorded_at:new Date().toISOString(), ...data });
}
async function saveCSAT(tenantId, data) {
  return save(tdb(tenantId,'csat'), { _id:'csat_'+uuid(), type:'csat', tenant_id:tenantId, ts:new Date().toISOString(), ...data });
}
async function saveBilling(tenantId, data) {
  return save(tdb(tenantId,'billing'), { _id:'bill_'+uuid(), type:'billing_record', tenant_id:tenantId, ts:new Date().toISOString(), ...data });
}
async function getPricing(tenantId) { return get(tdb(tenantId,'config'), 'pricing'); }
async function updatePricing(tenantId, updates) { return update(tdb(tenantId,'config'), 'pricing', updates); }
async function getPBXConfig(tenantId) { return get(tdb(tenantId,'config'), 'pbx_config'); }
async function savePBXConfig(tenantId, cfg) {
  const ex = await get(tdb(tenantId,'config'), 'pbx_config');
  const doc = { _id:'pbx_config', type:'pbx_config', tenant_id:tenantId, ...cfg, updated_at:new Date().toISOString() };
  if (ex) doc._rev = ex._rev;
  return save(tdb(tenantId,'config'), doc);
}
async function audit(action, actor, tenantId, data) {
  return save(G['vb_audit'], { _id:'audit_'+uuid(), type:'audit', action, actor, tenant_id:tenantId, ts:new Date().toISOString(), data });
}

module.exports = {
  initCouchDB, openTenantDBs, save, get, update, listAllDocs, viewQuery, findDocs,
  createTenant, getTenant, updateTenant, listTenants,
  saveCall, endCall, saveTranscript, saveCDR, saveCSAT, saveBilling,
  getPricing, updatePricing, getPBXConfig, savePBXConfig, audit,
  G, T, tdb,
};
