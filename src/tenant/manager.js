'use strict';
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db/couch');
const { createLogger } = require('../core/logger');
const log = createLogger('tenant');

async function createUser(tenantId, data) {
  const hash = await bcrypt.hash(data.password, 12);
  const doc = {
    _id: 'user_' + uuid(), type: 'agent', tenant_id: tenantId,
    name: data.name, email: data.email, username: data.username || data.email,
    password_hash: hash, role: data.role || 'agent',
    languages: data.languages || ['en'], exten: data.exten || null,
    status: 'offline', created_at: new Date().toISOString(),
  };
  const r = await db.save(db.tdb(tenantId, 'agents'), doc);
  return { id: r?.id, email: doc.email, role: doc.role };
}

async function getUser(tenantId, id) {
  const doc = await db.get(db.tdb(tenantId, 'agents'), id);
  if (!doc) return null;
  const { password_hash, ...safe } = doc; return safe;
}

async function listUsers(tenantId) {
  const docs = await db.listAllDocs(db.tdb(tenantId, 'agents'));
  return docs.filter(d => d && d.type === 'agent').map(({ password_hash, ...d }) => d);
}

async function authenticateUser(tenantId, email, password) {
  const docs = await db.findDocs(db.tdb(tenantId, 'agents'), { email }, null, 1);
  if (!docs.length) return null;
  const ok = await bcrypt.compare(password, docs[0].password_hash);
  if (!ok) return null;
  const { password_hash, ...safe } = docs[0]; return safe;
}

async function updateUserStatus(tenantId, userId, status) {
  return db.update(db.tdb(tenantId, 'agents'), userId, { status });
}

async function setPBXConfig(tenantId, config) {
  return db.savePBXConfig(tenantId, {
    pbx_type: config.type, host: config.host, port: config.port,
    username: config.username, password: config.password,
    context: config.context || 'techlife-inbound',
    esl_port: config.esl_port || 8021, esl_pass: config.esl_pass || 'ClueCon',
    ari_user: config.ari_user || 'techlife', ari_pass: config.ari_pass || 'techlifeari2024',
    ws_url: config.ws_url, api_url: config.api_url, api_key: config.api_key,
    enabled: true, updated_at: new Date().toISOString(),
  });
}

async function addWebhook(tenantId, webhook) {
  const tenant = await db.getTenant(tenantId);
  if (!tenant) throw new Error('Tenant not found');
  const webhooks = tenant.webhook_out || [];
  webhooks.push({
    id: uuid(), name: webhook.name, url: webhook.url,
    events: webhook.events || ['call.started', 'call.ended', 'transcript', 'cdr'],
    headers: webhook.headers || {}, enabled: true, created_at: new Date().toISOString(),
  });
  await db.updateTenant(tenantId, { webhook_out: webhooks });
  log.info('Webhook added [%s]: %s', tenantId, webhook.url);
}

async function removeWebhook(tenantId, webhookId) {
  const tenant = await db.getTenant(tenantId);
  await db.updateTenant(tenantId, { webhook_out: (tenant?.webhook_out || []).filter(w => w.id !== webhookId) });
}

async function setCRMIntegration(tenantId, crm) {
  await db.updateTenant(tenantId, {
    crm_integration: {
      type: crm.type, url: crm.url, api_key: crm.api_key,
      mapping: crm.mapping || {}, enabled: true, updated_at: new Date().toISOString(),
    }
  });
}

module.exports = { createUser, getUser, listUsers, authenticateUser, updateUserStatus, setPBXConfig, addWebhook, removeWebhook, setCRMIntegration };
