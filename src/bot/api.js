'use strict';
/**
 * Bot API Routes — mounted on /api/tenant/:tenantId/bot
 */
const express  = require('express');
const { v4: uuid } = require('uuid');
const auth     = require('../api/middleware/auth');
const db       = require('../db/couch');
const { processUtterance, getBotConfig } = require('./engine');
const outbound = require('./outbound');
const { createLogger } = require('../core/logger');
const log = createLogger('bot-api');

const router = express.Router({ mergeParams: true });

// ── Bot config (superadmin sets feature flags; tenant admin configures) ──
router.get('/config', auth.requireTenantAccess, async (req, res) => {
  const cfg = await getBotConfig(req.params.tenantId);
  if (cfg) {
    // Redact secrets
    const safe = { ...cfg };
    ['rasa_token','chatwoot_token','watson_api_key','openai_api_key','anthropic_api_key','custom_api_key','ms_app_password','aws_secret_key'].forEach(k => { if (safe[k]) safe[k] = '***'; });
    res.json(safe);
  } else {
    res.json({ enabled: false, bot_type: null });
  }
});

router.put('/config', auth.requireAdmin, async (req, res) => {
  try {
    const tid = req.params.tenantId;
    // Check superadmin has enabled bot for this tenant
    const tenant = await db.getTenant(tid);
    if (!tenant?.features?.bot_enabled) {
      return res.status(403).json({ error: 'Bot feature not enabled for this tenant by superadmin.' });
    }
    const existing = await db.get(db.tdb(tid, 'config'), 'bot_config').catch(() => null);
    const doc = { _id: 'bot_config', type: 'bot_config', tenant_id: tid, updated_at: new Date().toISOString(), ...req.body };
    if (existing) doc._rev = existing._rev;
    await db.save(db.tdb(tid, 'config'), doc);
    await db.audit('bot.config_updated', req.user.email, tid, { bot_type: req.body.bot_type });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Test bot connection ────────────────────────────────────────
router.post('/test', auth.requireAdmin, async (req, res) => {
  const tid = req.params.tenantId;
  const utterance = req.body.utterance || 'Hello, can you help me?';
  const lang      = req.body.lang || 'en';
  try {
    const result = await processUtterance(tid, `test_${uuid().slice(0,8)}`, utterance, lang, 'test_caller');
    res.json({ ok: true, result });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Text input to bot (from agent dashboard or API) ──────────
router.post('/chat', auth.requireTenantAccess, async (req, res) => {
  const { call_id, utterance, lang = 'en', caller_num } = req.body;
  const tid = req.params.tenantId;
  try {
    const result = await processUtterance(tid, call_id || `api_${uuid().slice(0,8)}`, utterance, lang, caller_num || 'api_caller');
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List bots for tenant ──────────────────────────────────────
router.get('/agents', auth.requireTenantAccess, async (req, res) => {
  const docs = await db.findDocs(db.tdb(req.params.tenantId, 'config'), { type: 'bot_agent' }, null, 100);
  res.json({ agents: docs });
});

router.post('/agents', auth.requireAdmin, async (req, res) => {
  try {
    const tid = req.params.tenantId;
    const doc = {
      _id: 'bot_' + uuid().slice(0, 12), type: 'bot_agent', tenant_id: tid,
      name:      req.body.name,
      bot_type:  req.body.bot_type,  // rasa|chatwoot|dialogflow|watson|lex|botframework|gpt4o|claude|custom
      direction: req.body.direction || 'inbound', // inbound|outbound|both
      extension: req.body.extension,
      enabled:   true,
      config:    req.body.config || {},
      escalation: req.body.escalation || {},
      created_at: new Date().toISOString(),
    };
    const r = await db.save(db.tdb(tid, 'config'), doc);
    await db.audit('bot.agent_created', req.user.email, tid, { name: req.body.name, type: req.body.bot_type });
    res.json({ id: r.id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/agents/:agentId', auth.requireAdmin, async (req, res) => {
  await db.update(db.tdb(req.params.tenantId, 'config'), req.params.agentId, req.body);
  res.json({ ok: true });
});

router.delete('/agents/:agentId', auth.requireAdmin, async (req, res) => {
  await db.update(db.tdb(req.params.tenantId, 'config'), req.params.agentId, { enabled: false, deleted: true });
  res.json({ ok: true });
});

// ── Outbound campaigns ────────────────────────────────────────
router.get('/campaigns', auth.requireTenantAccess, async (req, res) => {
  const campaigns = await outbound.listCampaigns(req.params.tenantId);
  res.json({ campaigns, count: campaigns.length });
});

router.post('/campaigns', auth.requireAdmin, async (req, res) => {
  try {
    const id = await outbound.createCampaign(req.params.tenantId, req.body);
    res.json({ id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/campaigns/:id', auth.requireTenantAccess, async (req, res) => {
  const c = await outbound.getCampaign(req.params.tenantId, req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

router.post('/campaigns/:id/start', auth.requireAdmin, async (req, res) => {
  try { await outbound.startCampaign(req.params.tenantId, req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/campaigns/:id/pause', auth.requireAdmin, async (req, res) => {
  await outbound.pauseCampaign(req.params.tenantId, req.params.id);
  res.json({ ok: true });
});

router.post('/campaigns/:id/stop', auth.requireAdmin, async (req, res) => {
  await outbound.stopCampaign(req.params.tenantId, req.params.id);
  res.json({ ok: true });
});

// Upload contacts CSV for campaign
router.post('/campaigns/:id/contacts', auth.requireAdmin, async (req, res) => {
  try {
    const contacts = req.body.contacts || [];
    const campaign = await outbound.getCampaign(req.params.tenantId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const updated = [...(campaign.contacts || []), ...contacts];
    await db.update(db.tdb(req.params.tenantId, 'config'), req.params.id, {
      contacts: updated,
      'stats.total': updated.length,
    });
    res.json({ ok: true, total: updated.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Superadmin — enable/disable bot per tenant ─────────────────
router.put('/features', auth.requireSuperAdmin, async (req, res) => {
  const { tenant_id, features } = req.body;
  const t = await db.getTenant(tenant_id || req.params.tenantId);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  await db.updateTenant(tenant_id || req.params.tenantId, {
    features: { ...(t.features || {}), ...features }
  });
  await db.audit('superadmin.features_updated', req.user.email, tenant_id, features);
  res.json({ ok: true });
});

// ── Bot analytics ─────────────────────────────────────────────
router.get('/analytics', auth.requireTenantAccess, async (req, res) => {
  const tid  = req.params.tenantId;
  const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);

  const turns = await db.findDocs(db.tdb(tid, 'transcripts'), { type: 'bot_turn', tenant_id: tid }, null, 10000);
  const inRange = turns.filter(t => { const d = (t.ts || '').slice(0, 10); return d >= from && d <= to; });

  const totalTurns    = inRange.length;
  const escalated     = inRange.filter(t => t.escalate).length;
  const byBotType     = {};
  const byIntent      = {};
  let totalMs = 0;

  for (const t of inRange) {
    byBotType[t.bot_type || 'unknown'] = (byBotType[t.bot_type || 'unknown'] || 0) + 1;
    if (t.intent) byIntent[t.intent] = (byIntent[t.intent] || 0) + 1;
    totalMs += t.ms || 0;
  }

  const campaigns = await outbound.listCampaigns(tid);
  const campStats = campaigns.reduce((s, c) => ({
    total_dialled:   (s.total_dialled   || 0) + (c.stats?.dialled   || 0),
    total_answered:  (s.total_answered  || 0) + (c.stats?.answered  || 0),
    total_completed: (s.total_completed || 0) + (c.stats?.completed || 0),
  }), {});

  res.json({
    period: { from, to },
    total_turns: totalTurns,
    escalated, escalation_rate: totalTurns ? Math.round(escalated / totalTurns * 100) : 0,
    avg_latency_ms: totalTurns ? Math.round(totalMs / totalTurns) : 0,
    by_bot_type: byBotType,
    top_intents: Object.entries(byIntent).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([intent, count]) => ({ intent, count })),
    outbound: campStats,
  });
});

module.exports = router;
