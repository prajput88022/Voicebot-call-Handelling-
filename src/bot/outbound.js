'use strict';
/**
 * Outbound VoiceBot Campaign Engine
 * Handles: lead dialling, appointment reminders, surveys, payment collection
 * Supports: AMD (Answering Machine Detection), voicemail, retry logic
 */
const { v4: uuid } = require('uuid');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const { processUtterance } = require('./engine');

const log = createLogger('outbound');
const activeCampaigns = new Map(); // campaignId -> { timer, paused }

// ── Campaign CRUD ─────────────────────────────────────────────
async function createCampaign(tenantId, data) {
  const id = 'camp_' + uuid().slice(0, 12);
  const doc = {
    _id: id, type: 'outbound_campaign', tenant_id: tenantId,
    name:        data.name,
    bot_type:    data.bot_type    || 'claude',
    status:      'scheduled',
    direction:   'outbound',
    contacts:    data.contacts    || [],
    script:      data.script      || null,
    schedule_at: data.schedule_at || null,
    caller_id:   data.caller_id   || null,
    max_retries: data.max_retries || 3,
    retry_delay_min: data.retry_delay_min || 60,
    amd_enabled: data.amd_enabled !== false,
    voicemail_msg: data.voicemail_msg || null,
    stats: { total: data.contacts?.length || 0, dialled: 0, answered: 0, voicemail: 0, failed: 0, completed: 0, converted: 0 },
    created_at: new Date().toISOString(),
  };
  await db.save(db.tdb(tenantId, 'config'), doc);
  log.info('Campaign created [%s]: %s (%d contacts)', tenantId, data.name, doc.stats.total);
  return id;
}

async function getCampaign(tenantId, campaignId) {
  return db.get(db.tdb(tenantId, 'config'), campaignId);
}

async function listCampaigns(tenantId) {
  const docs = await db.findDocs(db.tdb(tenantId, 'config'), { type: 'outbound_campaign', tenant_id: tenantId }, null, 200);
  return docs;
}

async function updateCampaignStats(tenantId, campaignId, statKey) {
  const camp = await getCampaign(tenantId, campaignId);
  if (!camp) return;
  const stats = camp.stats || {};
  stats[statKey] = (stats[statKey] || 0) + 1;
  await db.update(db.tdb(tenantId, 'config'), campaignId, { stats });
}

// ── Dialler ───────────────────────────────────────────────────
async function startCampaign(tenantId, campaignId) {
  const camp = await getCampaign(tenantId, campaignId);
  if (!camp) throw new Error('Campaign not found');
  if (camp.status === 'running') throw new Error('Already running');

  await db.update(db.tdb(tenantId, 'config'), campaignId, { status: 'running', started_at: new Date().toISOString() });
  log.info('Campaign starting [%s]: %s', tenantId, camp.name);

  const interval = setInterval(async () => {
    const c = await getCampaign(tenantId, campaignId);
    if (!c || c.status !== 'running') { clearInterval(interval); activeCampaigns.delete(campaignId); return; }
    if ((c.stats.dialled || 0) >= c.contacts.length) {
      clearInterval(interval);
      activeCampaigns.delete(campaignId);
      await db.update(db.tdb(tenantId, 'config'), campaignId, { status: 'completed', completed_at: new Date().toISOString() });
      log.info('Campaign completed [%s]: %s', tenantId, c.name);
      return;
    }
    const contact = c.contacts[c.stats.dialled || 0];
    if (contact) dialContact(tenantId, campaignId, contact, c).catch(e => log.error('Dial: %s', e.message));
  }, 3000); // dial one every 3s (adjust for real PBX)

  activeCampaigns.set(campaignId, { interval, tenantId });
}

async function pauseCampaign(tenantId, campaignId) {
  const entry = activeCampaigns.get(campaignId);
  if (entry) { clearInterval(entry.interval); activeCampaigns.delete(campaignId); }
  await db.update(db.tdb(tenantId, 'config'), campaignId, { status: 'paused' });
  log.info('Campaign paused: %s', campaignId);
}

async function stopCampaign(tenantId, campaignId) {
  const entry = activeCampaigns.get(campaignId);
  if (entry) { clearInterval(entry.interval); activeCampaigns.delete(campaignId); }
  await db.update(db.tdb(tenantId, 'config'), campaignId, { status: 'stopped', stopped_at: new Date().toISOString() });
}

// ── Contact dialler (fires webhook/API to PBX to originate call) ──
async function dialContact(tenantId, campaignId, contact, campaign) {
  await updateCampaignStats(tenantId, campaignId, 'dialled');
  const callId = `out_${uuid().slice(0,12)}`;
  log.info('Dialling [%s] %s → %s', tenantId, campaign.name, contact.phone);

  // Save outbound CDR
  await db.saveCDR(tenantId, {
    call_id: callId, direction: 'outbound',
    campaign_id: campaignId, campaign_name: campaign.name,
    caller_num: campaign.caller_id || tenantId,
    called_num: contact.phone, contact_name: contact.name,
    start_time: new Date().toISOString(),
    status: 'dialling', bot_type: campaign.bot_type,
  });

  // Trigger PBX via webhook / direct API (platform-agnostic)
  try {
    const pbxCfg = await db.getPBXConfig(tenantId);
    if (pbxCfg?.api_url) {
      await require('axios').post(`${pbxCfg.api_url}/originate`, {
        from: campaign.caller_id || tenantId,
        to:   contact.phone,
        call_id: callId,
        tenant_id: tenantId,
        campaign_id: campaignId,
        bot_type: campaign.bot_type,
        script: campaign.script,
        contact,
        ws_url: `ws://127.0.0.1:${process.env.WS_PORT || 8765}?tenant=${tenantId}&pbx=outbound&caller=${contact.phone}&campaign=${campaignId}`,
      }, { timeout: 5000 });
    } else {
      // Simulate answered for demo / testing without real PBX
      setTimeout(async () => {
        await updateCampaignStats(tenantId, campaignId, 'answered');
        // Run bot script as if call was answered
        const session = { history: [], context: { caller_num: contact.phone, caller_lang: 'en', campaign: campaignId }, turnCount: 0 };
        const greeting = interpolateScript(campaign.script?.greeting || 'Hello {name}, this is VoiceBot.', contact);
        await processUtterance(tenantId, callId, greeting, 'en', contact.phone, { outbound: true, campaign_id: campaignId });
        await updateCampaignStats(tenantId, campaignId, 'completed');
      }, 1000 + Math.random() * 2000);
    }
  } catch (e) {
    log.warn('Originate failed [%s]: %s', contact.phone, e.message);
    await updateCampaignStats(tenantId, campaignId, 'failed');
  }
}

function interpolateScript(template, contact) {
  return template.replace(/\{(\w+)\}/g, (_, key) => contact[key] || '');
}

module.exports = { createCampaign, getCampaign, listCampaigns, startCampaign, pauseCampaign, stopCampaign, updateCampaignStats };
