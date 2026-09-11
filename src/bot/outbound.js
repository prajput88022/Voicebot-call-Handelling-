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
const aiClient = require('../ai/client');
const media = require('./media');

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
    // New media/tts fields
    audio_file: data.audio_file || null,         // single audio for whole campaign
    tts_template: data.tts_template || null,     // template text to synthesize per-contact
    tts_voice: data.tts_voice || null,
    tts_lang: data.tts_lang || 'en',
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

  // Pre-generate TTS audio per-contact if template provided
  if (camp.tts_template) {
    try {
      log.info('Pre-generating TTS for campaign %s (%d contacts)', campaignId, (camp.contacts||[]).length);
      for (let i = 0; i < (camp.contacts || []).length; i++) {
        const contact = camp.contacts[i];
        if (contact.audio_file) continue; // already present
        const text = interpolateScript(camp.tts_template, contact);
        // Determine language to synthesize
        const lang = contact.lang || camp.tts_lang || 'en';
        const buf = await aiClient.synthesize(text, lang, null);
        if (buf) {
          const filename = `${campaignId}_${i}.wav`;
          const publicPath = await media.saveAudio(tenantId, filename, buf.toString('base64'));
          contact.audio_file = publicPath;
        } else {
          log.warn('TTS generation failed for campaign %s contact %s', campaignId, contact.phone);
        }
      }
      // persist updated contacts
      await db.update(db.tdb(tenantId, 'config'), campaignId, { contacts: camp.contacts });
    } catch (e) { log.warn('TTS pre-generation error: %s', e.message); }
  }

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
    // playback metadata
    playback: { audio_file: contact.audio_file || campaign.audio_file || null, tts_template: campaign.tts_template || null, tts_voice: campaign.tts_voice || null }
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
        // include playback hints for PBX handler
        play_audio: contact.audio_file || campaign.audio_file || null,
        tts_text: contact.audio_file ? null : (campaign.tts_template ? interpolateScript(campaign.tts_template, contact) : null),
        tts_voice: campaign.tts_voice || null,
        ws_url: `ws://127.0.0.1:${process.env.WS_PORT || 8765}?tenant=${tenantId}&pbx=outbound&caller=${contact.phone}&campaign=${campaignId}&call_id=${callId}`,
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
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => contact[key] || '');
}

module.exports = { createCampaign, getCampaign, listCampaigns, startCampaign, pauseCampaign, stopCampaign, updateCampaignStats };
