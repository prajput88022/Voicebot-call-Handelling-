'use strict';
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const compression = require('compression');
const bcrypt    = require('bcryptjs');
const { v4: uuid } = require('uuid');
const path      = require('path');
const swaggerUI = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const { createLogger } = require('../core/logger');
const auth    = require('./middleware/auth');
const db      = require('../db/couch');
const tenant  = require('../tenant/manager');
const ai      = require('../ai/client');
const reports = require('../reports/engine');
const billing = require('../billing/engine');
const { sessions } = require('../realtime/ws-bridge');

const botRouter = require('../bot/api');
const log = createLogger('api');

const swaggerSpec = swaggerJSDoc({
  definition: { openapi:'3.0.0', info:{ title:'TechLife VoiceBridge Enterprise API', version:'2.0.0', description:'Multi-Tenant AI Call Center Platform' }, servers:[{ url:'http://localhost:4000' }], components:{ securitySchemes:{ bearerAuth:{ type:'http', scheme:'bearer', bearerFormat:'JWT' } } }, security:[{ bearerAuth:[] }] },
  apis: [__filename],
});

async function startAPI(port) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy:false, crossOriginOpenerPolicy:false, originAgentCluster:false }));
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit:'10mb' }));
  app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(swaggerSpec));
  app.use('/', express.static(path.join(__dirname, '../../public')));
  app.use('/api/tenant/:tenantId/bot', botRouter);

  // ════════════════════════════════════════════════════════════
  //  HEALTH
  // ════════════════════════════════════════════════════════════
  app.get('/health', (req, res) => res.json({ status:'ok', version:'2.0.0', uptime:Math.round(process.uptime()) }));
  app.get('/api/stats', async (req, res) => {
    const tenants = await db.listTenants().catch(() => []);
    res.json({ total_tenants:tenants.length, active_calls:sessions.size, uptime:Math.round(process.uptime()), node:process.version });
  });

  // ════════════════════════════════════════════════════════════
  //  SUPERADMIN AUTH
  // ════════════════════════════════════════════════════════════
  app.post('/api/superadmin/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const docs = await db.findDocs(db.G['vb_superadmins'], { email }, null, 1);
      if (!docs.length) return res.status(401).json({ error:'Invalid credentials' });
      const ok = await bcrypt.compare(password, docs[0].password_hash);
      if (!ok) return res.status(401).json({ error:'Invalid credentials' });
      const token = auth.sign({ id:docs[0]._id, email, role:'superadmin' });
      await db.audit('superadmin.login', email, null, {});
      res.json({ token, role:'superadmin', name:'Super Admin' });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════
  //  SUPERADMIN — TENANTS
  // ════════════════════════════════════════════════════════════
  app.get('/api/superadmin/tenants', auth.requireSuperAdmin, async (req, res) => {
    const list = await db.listTenants();
    res.json({ tenants:list, count:list.length });
  });

  app.post('/api/superadmin/tenants', auth.requireSuperAdmin, async (req, res) => {
    try {
      const id = await db.createTenant(req.body);
      // Create initial admin user if provided
      if (req.body.admin_email && req.body.admin_password) {
        await tenant.createUser(id, { name:'Admin User', email:req.body.admin_email, password:req.body.admin_password, role:'admin' });
      }
      await db.audit('tenant.created', req.user.email, id, req.body);
      res.json({ id, ok:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/superadmin/tenants/:id', auth.requireSuperAdmin, async (req, res) => {
    const t = await db.getTenant(req.params.id);
    if (!t) return res.status(404).json({ error:'Not found' });
    res.json(t);
  });

  app.put('/api/superadmin/tenants/:id', auth.requireSuperAdmin, async (req, res) => {
    await db.updateTenant(req.params.id, req.body);
    await db.audit('tenant.updated', req.user.email, req.params.id, req.body);
    res.json({ ok:true });
  });

  app.delete('/api/superadmin/tenants/:id', auth.requireSuperAdmin, async (req, res) => {
    await db.update(db.G['vb_tenants'], req.params.id, { status:'suspended' });
    await db.audit('tenant.suspended', req.user.email, req.params.id, {});
    res.json({ ok:true });
  });

  app.get('/api/superadmin/stats', auth.requireSuperAdmin, async (req, res) => {
    const tenants = await db.listTenants();
    let totalCost = 0;
    for (const t of tenants) { const b = await billing.getMonthlyBilling(t._id).catch(()=>({total_cost:0})); totalCost += b.total_cost||0; }
    res.json({ total_tenants:tenants.length, active_tenants:tenants.filter(t=>t.status==='active').length, total_active_calls:sessions.size, total_cost_month:totalCost });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT AUTH
  // ════════════════════════════════════════════════════════════
  app.post('/api/tenant/:tenantId/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const t = await db.getTenant(req.params.tenantId);
      if (!t || t.status !== 'active') return res.status(403).json({ error:'Tenant inactive or not found' });
      const user = await tenant.authenticateUser(req.params.tenantId, email, password);
      if (!user) return res.status(401).json({ error:'Invalid credentials' });
      const token = auth.sign({ id:user._id, email, role:user.role, tenant_id:req.params.tenantId });
      await db.audit('user.login', email, req.params.tenantId, { role:user.role });
      res.json({ token, user:{ id:user._id, name:user.name, role:user.role, email }, tenant:{ id:t._id, name:t.name, plan:t.plan } });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — USERS
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/users', auth.requireTenantAccess, async (req, res) => {
    const users = await tenant.listUsers(req.params.tenantId);
    res.json({ users, count:users.length });
  });

  app.post('/api/tenant/:tenantId/users', auth.requireAdmin, async (req, res) => {
    try {
      const user = await tenant.createUser(req.params.tenantId, req.body);
      await db.audit('user.created', req.user.email, req.params.tenantId, { email:req.body.email, role:req.body.role });
      res.json({ ok:true, ...user });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.put('/api/tenant/:tenantId/users/:uid/status', auth.requireTenantAccess, async (req, res) => {
    await tenant.updateUserStatus(req.params.tenantId, req.params.uid, req.body.status);
    res.json({ ok:true });
  });

  app.delete('/api/tenant/:tenantId/users/:uid', auth.requireAdmin, async (req, res) => {
    await db.update(db.tdb(req.params.tenantId,'agents'), req.params.uid, { status:'deleted' });
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — CALLS
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/calls', auth.requireTenantAccess, async (req, res) => {
    const rows = await db.viewQuery(db.tdb(req.params.tenantId,'calls'), 'idx', 'active', { key:req.params.tenantId, include_docs:true });
    const calls = rows.map(r => r.doc||r.value);
    // Merge with live sessions
    const liveSessions = [...sessions.entries()].filter(([,s]) => s.tenantId===req.params.tenantId).map(([id,s]) => ({ call_id:id, pbx:s.pbxType, duration:Math.round((Date.now()-s.started)/1000), status:'active' }));
    res.json({ calls, live_sessions:liveSessions, count:calls.length });
  });

  app.get('/api/tenant/:tenantId/calls/:callId', auth.requireTenantAccess, async (req, res) => {
    const call = await db.get(db.tdb(req.params.tenantId,'calls'), req.params.callId);
    if (!call) return res.status(404).json({ error:'Not found' });
    const txs = await db.findDocs(db.tdb(req.params.tenantId,'transcripts'), { call_id:req.params.callId }, null, 500);
    res.json({ call, transcripts:txs });
  });

  app.post('/api/tenant/:tenantId/calls/incoming', async (req, res) => {
    try {
      const tid = req.params.tenantId;
      const t = await db.getTenant(tid);
      if (!t || t.status !== 'active') return res.status(403).json({ error:'Tenant inactive' });
      const callId = req.body.call_id || uuid();
      await db.saveCall(tid, { call_id:callId, pbx:req.body.pbx||'api', caller_num:req.body.caller, exten:req.body.exten });
      const users = await tenant.listUsers(tid);
      const available = users.filter(u => u.status==='online' && u.role==='agent');
      res.json({ call_id:callId, agent:available[0]||null });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/tenant/:tenantId/calls/:callId/hangup', async (req, res) => {
    await db.endCall(req.params.tenantId, req.params.callId, { duration_sec:req.body.duration||0 });
    res.json({ ok:true });
  });

  app.post('/api/tenant/:tenantId/csat', async (req, res) => {
    await db.saveCSAT(req.params.tenantId, req.body);
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — AI
  // ════════════════════════════════════════════════════════════
  app.post('/api/tenant/:tenantId/ai/chat', auth.requireTenantAccess, async (req, res) => {
    try {
      const { message, lang='en', history=[], call_id, vendor } = req.body;
      const t0 = Date.now();
      const pricing = await db.getPricing(req.params.tenantId).catch(()=>null);
      const v = vendor || (pricing ? Object.keys(pricing.vendors?.llm||{})[0] : 'claude_sonnet');
      const msgs = [...history, { role:'user', content:`[${lang}]: ${message}` }];
      const result = await ai.callCenterRespond({ history:msgs, callerLang:lang, callId:call_id, tenantId:req.params.tenantId, vendor:v });
      if (call_id) await billing.recordUsage(req.params.tenantId, call_id, { llm_vendor:result.vendor, llm_tokens_in:result.tokens_in, llm_tokens_out:result.tokens_out });
      res.json({ reply:result.text, vendor:result.vendor, ms:Date.now()-t0 });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/tenant/:tenantId/ai/translate', auth.requireTenantAccess, async (req, res) => {
    const { text, source, target='en', vendor } = req.body;
    const result = await ai.translate(text, source, target, vendor);
    res.json(result);
  });

  app.post('/api/tenant/:tenantId/ai/detect', auth.requireTenantAccess, async (req, res) => {
    const result = await ai.detectLanguage(req.body.text||'');
    res.json({ ...result, lang_name:ai.LANG_NAMES[result.lang]||result.lang });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — PRICING
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/pricing', auth.requireAdmin, async (req, res) => {
    const cfg = await db.getPricing(req.params.tenantId);
    res.json(cfg || {});
  });

  app.put('/api/tenant/:tenantId/pricing', auth.requireAdmin, async (req, res) => {
    await db.updatePricing(req.params.tenantId, req.body);
    await db.audit('pricing.updated', req.user.email, req.params.tenantId, {});
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — PBX
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/pbx', auth.requireAdmin, async (req, res) => {
    const cfg = await db.getPBXConfig(req.params.tenantId);
    if (cfg) { cfg.password = cfg.password?'***':null; cfg.esl_pass='***'; cfg.api_key=cfg.api_key?'***':null; }
    res.json(cfg || {});
  });

  app.put('/api/tenant/:tenantId/pbx', auth.requireAdmin, async (req, res) => {
    await tenant.setPBXConfig(req.params.tenantId, req.body);
    await db.audit('pbx.updated', req.user.email, req.params.tenantId, { type:req.body.type });
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — WEBHOOKS
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/webhooks', auth.requireAdmin, async (req, res) => {
    const t = await db.getTenant(req.params.tenantId);
    res.json({ webhooks:t?.webhook_out||[] });
  });

  app.post('/api/tenant/:tenantId/webhooks', auth.requireAdmin, async (req, res) => {
    await tenant.addWebhook(req.params.tenantId, req.body);
    await db.audit('webhook.added', req.user.email, req.params.tenantId, { url:req.body.url });
    res.json({ ok:true });
  });

  app.delete('/api/tenant/:tenantId/webhooks/:webhookId', auth.requireAdmin, async (req, res) => {
    await tenant.removeWebhook(req.params.tenantId, req.params.webhookId);
    res.json({ ok:true });
  });

  app.post('/api/tenant/:tenantId/webhooks/test', auth.requireAdmin, async (req, res) => {
    const { url, headers={} } = req.body;
    try {
      const r = await require('axios').post(url, { event:'webhook.test', tenant_id:req.params.tenantId, ts:new Date().toISOString(), message:'TechLife VoiceBridge webhook test' }, { headers, timeout:8000 });
      res.json({ ok:true, status:r.status });
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — CRM
  // ════════════════════════════════════════════════════════════
  app.put('/api/tenant/:tenantId/crm', auth.requireAdmin, async (req, res) => {
    await tenant.setCRMIntegration(req.params.tenantId, req.body);
    await db.audit('crm.updated', req.user.email, req.params.tenantId, { type:req.body.type });
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — ORDERS
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/orders/:id', auth.requireTenantAccess, async (req, res) => {
    const doc = await db.get(db.tdb(req.params.tenantId,'orders'), 'order_'+req.params.id);
    res.json(doc || { error:'Not found' });
  });

  app.post('/api/tenant/:tenantId/orders', auth.requireTenantAccess, async (req, res) => {
    const doc = { _id:'order_'+(req.body.order_id||uuid()), type:'order', ...req.body };
    const r = await db.save(db.tdb(req.params.tenantId,'orders'), doc);
    res.json({ id:r?.id });
  });

  // ════════════════════════════════════════════════════════════
  //  TENANT — REPORTS
  // ════════════════════════════════════════════════════════════
  app.get('/api/tenant/:tenantId/reports/dashboard', auth.requireTenantAccess, async (req, res) => {
    const s = await reports.getDashboardSummary(req.params.tenantId);
    res.json(s);
  });

  app.get('/api/tenant/:tenantId/reports/cdr', auth.requireTenantAccess, async (req, res) => {
    const { from, to, format } = req.query;
    const data = await reports.getCDR(req.params.tenantId, from, to, req.query);
    if (format === 'csv') {
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition','attachment; filename=cdr.csv');
      return res.send(reports.toCSV(data.records, ['_id','start_time','caller_num','agent_id','queue','duration_sec','wait_sec','disposition','caller_lang']));
    }
    res.json(data);
  });

  app.get('/api/tenant/:tenantId/reports/acd',     auth.requireTenantAccess, async (req, res) => res.json(await reports.getACDReport(req.params.tenantId, req.query.from, req.query.to)));
  app.get('/api/tenant/:tenantId/reports/csat',    auth.requireTenantAccess, async (req, res) => res.json(await reports.getCSATReport(req.params.tenantId, req.query.from, req.query.to)));
  app.get('/api/tenant/:tenantId/reports/queue',   auth.requireTenantAccess, async (req, res) => res.json(await reports.getQueueReport(req.params.tenantId, req.query.from, req.query.to)));
  app.get('/api/tenant/:tenantId/reports/billing', auth.requireAdmin,        async (req, res) => res.json(await reports.getBillingReport(req.params.tenantId, req.query.month)));
  app.get('/api/tenant/:tenantId/reports/agents',  auth.requireTenantAccess, async (req, res) => res.json(await reports.getAgentReport(req.params.tenantId, req.query.from, req.query.to)));

  app.post('/api/tenant/:tenantId/reports/deliver', auth.requireAdmin, async (req, res) => {
    const { report_type, from, to, delivery, month } = req.body;
    let data;
    if      (report_type==='cdr')     data = await reports.getCDR(req.params.tenantId, from, to);
    else if (report_type==='acd')     data = await reports.getACDReport(req.params.tenantId, from, to);
    else if (report_type==='csat')    data = await reports.getCSATReport(req.params.tenantId, from, to);
    else if (report_type==='billing') data = await reports.getBillingReport(req.params.tenantId, month);
    else if (report_type==='agents')  data = await reports.getAgentReport(req.params.tenantId, from, to);
    else                              data = await reports.getDashboardSummary(req.params.tenantId);
    await reports.deliverReport(req.params.tenantId, { report_type, ...data }, delivery);
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════
  //  SEED (first-run superadmin creation)
  // ════════════════════════════════════════════════════════════
  app.post('/api/seed', async (req, res) => {
    const email = process.env.SUPERADMIN_EMAIL || 'superadmin@techlife.ai';
    const pass  = process.env.SUPERADMIN_PASS  || 'SuperAdmin@2024';
    const existing = await db.findDocs(db.G['vb_superadmins'], { email }, null, 1);
    if (!existing.length) {
      const hash = await bcrypt.hash(pass, 12);
      await db.save(db.G['vb_superadmins'], { _id:'sa_'+uuid(), type:'superadmin', email, password_hash:hash, name:'Super Admin', created_at:new Date().toISOString() });
    }
    res.json({ ok:true });
  });

  app.use((err, req, res, next) => { log.error('API: %s', err.message); res.status(500).json({ error:err.message }); });

  await new Promise(r => app.listen(port, '0.0.0.0', r));
  // Auto-seed on start
  try { await require('axios').post(`http://127.0.0.1:${port}/api/seed`); } catch {}
  return app;
}

module.exports = { startAPI };
