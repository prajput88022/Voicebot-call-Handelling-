'use strict';
const axios = require('axios');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const log = createLogger('webhook-out');

async function fireOutboundWebhooks(tenantId, event, data) {
  try {
    const tenant = await db.getTenant(tenantId);
    if (!tenant) return;
    const payload = { event, tenant_id: tenantId, ts: new Date().toISOString(), data };
    const hooks = (tenant.webhook_out || []).filter(w => w.enabled && w.events?.includes(event));
    await Promise.allSettled(hooks.map(wh => fireOne(wh, payload)));
    if (tenant.crm_integration?.enabled) await fireCRM(tenant.crm_integration, event, payload);
  } catch (e) { log.error('fire [%s/%s]: %s', tenantId, event, e.message); }
}

async function fireOne(webhook, payload) {
  try {
    await axios.post(webhook.url, payload, { headers: { 'Content-Type': 'application/json', ...webhook.headers }, timeout: 8000 });
    log.debug('Webhook fired: %s → %s', payload.event, webhook.url);
  } catch (e) { log.warn('Webhook failed [%s]: %s', webhook.url, e.message); }
}

async function fireCRM(crm, event, payload) {
  if (!crm.url || !crm.api_key) return;
  if (event !== 'call.ended') return; // Only send on call end by default
  const d = payload.data || {};
  let body, headers = { 'Content-Type': 'application/json' };
  try {
    switch (crm.type) {
      case 'hubspot':
        body = { properties: { hs_call_duration: (d.duration_sec||0)*1000, hs_call_status:'COMPLETED', hs_call_direction:'INBOUND', hs_call_caller_id: d.caller_num||'', hs_call_body: d.transcript||'' } };
        headers.Authorization = `Bearer ${crm.api_key}`;
        await axios.post(`https://api.hubapi.com/crm/v3/objects/calls`, body, { headers, timeout:8000 });
        break;
      case 'salesforce':
        body = { Subject:`Call from ${d.caller_num}`, Description: d.transcript||'', Status:'Completed', ActivityDate: new Date().toISOString().slice(0,10) };
        headers.Authorization = `Bearer ${crm.api_key}`;
        await axios.post(`${crm.url}/services/data/v58.0/sobjects/Task`, body, { headers, timeout:8000 });
        break;
      case 'zendesk':
        body = { ticket: { subject:`Call from ${d.caller_num}`, comment:{ body:`Duration: ${d.duration_sec}s\nTranscript: ${d.transcript||''}` }, tags:['voicebridge'] } };
        headers.Authorization = `Bearer ${crm.api_key}`;
        await axios.post(`${crm.url}/api/v2/tickets`, body, { headers, timeout:8000 });
        break;
      case 'zoho':
        body = { data: [{ Subject:`Call from ${d.caller_num}`, Description:d.transcript||'', Duration:d.duration_sec||0 }] };
        headers.Authorization = `Zoho-oauthtoken ${crm.api_key}`;
        await axios.post(`https://www.zohoapis.com/crm/v3/Calls`, body, { headers, timeout:8000 });
        break;
      default:
        await axios.post(crm.url, payload, { headers:{ ...headers, 'X-API-Key':crm.api_key }, timeout:8000 });
    }
    log.debug('CRM fired: %s → %s', event, crm.type);
  } catch (e) { log.warn('CRM [%s]: %s', crm.type, e.message); }
}

module.exports = { fireOutboundWebhooks };
