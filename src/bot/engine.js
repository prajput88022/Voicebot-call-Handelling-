'use strict';
/**
 * VoiceBot Engine — Unified interface for all bot providers
 * Supports: Rasa, Chatwoot, Dialogflow CX, IBM Watson Assistant,
 *           Amazon Lex, Microsoft Bot Framework, GPT-4o Function Calling,
 *           Claude AI (native), Custom HTTP webhook
 */
const axios = require('axios');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const log = createLogger('bot-engine');

// ── Session store (in-memory, per call) ───────────────────────
const botSessions = new Map(); // callId -> { botType, sessionId, history, context }

function getSession(callId) {
  if (!botSessions.has(callId)) {
    botSessions.set(callId, { history: [], context: {}, turnCount: 0, escalated: false });
  }
  return botSessions.get(callId);
}
function endSession(callId) { botSessions.delete(callId); }

// ── Get bot config for tenant ─────────────────────────────────
async function getBotConfig(tenantId) {
  try {
    const cfg = await db.get(db.tdb(tenantId, 'config'), 'bot_config');
    return cfg || null;
  } catch { return null; }
}

// ── Main dispatcher ───────────────────────────────────────────
async function processUtterance(tenantId, callId, utterance, callerLang, callerNum, extra = {}) {
  const t0 = Date.now();
  const session = getSession(callId);
  session.turnCount++;
  session.context.caller_num  = callerNum;
  session.context.caller_lang = callerLang;
  session.context.tenant_id   = tenantId;

  const botCfg = await getBotConfig(tenantId);
  if (!botCfg || !botCfg.enabled) {
    // Fallback to Claude AI
    return processWithClaude(tenantId, callId, utterance, callerLang, session, {}, t0);
  }

  let result;
  switch (botCfg.bot_type) {
    case 'rasa':        result = await processWithRasa(botCfg, callId, utterance, callerLang, session, t0); break;
    case 'chatwoot':    result = await processWithChatwoot(botCfg, callId, utterance, callerLang, session, tenantId, t0); break;
    case 'dialogflow':  result = await processWithDialogflow(botCfg, callId, utterance, callerLang, session, t0); break;
    case 'watson':      result = await processWithWatson(botCfg, callId, utterance, callerLang, session, t0); break;
    case 'lex':         result = await processWithLex(botCfg, callId, utterance, callerLang, session, t0); break;
    case 'botframework':result = await processWithBotFramework(botCfg, callId, utterance, callerLang, session, t0); break;
    case 'gpt4o':       result = await processWithGPT4o(botCfg, callId, utterance, callerLang, session, tenantId, t0); break;
    case 'claude':      result = await processWithClaude(tenantId, callId, utterance, callerLang, session, botCfg, t0); break;
    case 'custom':      result = await processWithCustom(botCfg, callId, utterance, callerLang, session, tenantId, t0); break;
    default:            result = await processWithClaude(tenantId, callId, utterance, callerLang, session, botCfg, t0);
  }

  // Check escalation rules
  const escalate = checkEscalation(result, session, botCfg);
  if (escalate && !session.escalated) {
    session.escalated = true;
    result.escalate     = true;
    result.escalate_reason = escalate;
    result.escalate_brief  = buildBrief(session, utterance);
  }

  // Save turn to DB
  await db.saveTranscript(tenantId, {
    call_id: callId, type: 'bot_turn',
    utterance, response: result.response,
    intent: result.intent, confidence: result.confidence,
    bot_type: botCfg?.bot_type || 'claude',
    lang: callerLang, ms: Date.now() - t0,
    escalate: result.escalate || false,
  }).catch(() => {});

  session.history.push({ role: 'user', content: utterance });
  session.history.push({ role: 'assistant', content: result.response });
  if (session.history.length > 30) session.history.splice(0, 2);

  return { ...result, ms: Date.now() - t0 };
}

// ── Rasa ──────────────────────────────────────────────────────
async function processWithRasa(cfg, callId, utterance, lang, session, t0) {
  try {
    const rasaUrl = cfg.rasa_url || 'http://127.0.0.1:5005';
    const sender  = `vb_${callId.slice(0, 8)}`;

    const r = await axios.post(`${rasaUrl}/webhooks/rest/webhook`, {
      sender, message: utterance,
      metadata: { lang, caller: session.context.caller_num, tenant: session.context.tenant_id },
    }, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      timeout: 5000,
    });

    const messages = r.data || [];
    const response = messages.map(m => m.text || '').filter(Boolean).join(' ') ||
                     'I didn\'t quite catch that. Could you repeat?';

    // Get NLU parse for intent/confidence
    let intent = null, confidence = 0;
    try {
      const nlu = await axios.post(`${rasaUrl}/model/parse`, { text: utterance }, { timeout: 3000 });
      intent     = nlu.data?.intent?.name;
      confidence = nlu.data?.intent?.confidence || 0;
    } catch {}

    return { response, intent, confidence, bot_type: 'rasa', raw: messages };
  } catch (e) {
    log.warn('Rasa error: %s', e.message);
    return { response: 'I\'m having trouble processing that. One moment please.', bot_type: 'rasa', error: e.message };
  }
}

// ── Chatwoot ──────────────────────────────────────────────────
async function processWithChatwoot(cfg, callId, utterance, lang, session, tenantId, t0) {
  try {
    const base    = cfg.chatwoot_url || 'https://app.chatwoot.com';
    const token   = cfg.chatwoot_token;
    const accountId = cfg.chatwoot_account_id || 1;
    const inboxId   = cfg.chatwoot_inbox_id || 1;
    const headers   = { api_access_token: token, 'Content-Type': 'application/json' };

    // Create or get contact
    let contactId = session.context.chatwoot_contact_id;
    if (!contactId) {
      const phone = session.context.caller_num || '+0000000000';
      const contact = await axios.post(`${base}/api/v1/accounts/${accountId}/contacts`, {
        name: `VoiceBot caller ${phone}`, phone_number: phone,
        additional_attributes: { tenant_id: tenantId, call_id: callId, lang },
      }, { headers, timeout: 6000 });
      contactId = contact.data?.payload?.id || contact.data?.id;
      session.context.chatwoot_contact_id = contactId;
    }

    // Create or get conversation
    let convId = session.context.chatwoot_conv_id;
    if (!convId) {
      const conv = await axios.post(`${base}/api/v1/accounts/${accountId}/conversations`, {
        contact_id: contactId, inbox_id: inboxId,
        additional_attributes: { call_id: callId, bot_session: true },
      }, { headers, timeout: 6000 });
      convId = conv.data?.id;
      session.context.chatwoot_conv_id = convId;
    }

    // Send message and get bot reply
    await axios.post(`${base}/api/v1/accounts/${accountId}/conversations/${convId}/messages`, {
      content: utterance, message_type: 'incoming', content_type: 'text',
    }, { headers, timeout: 6000 });

    // Poll for bot reply (Chatwoot bot replies asynchronously)
    await new Promise(r => setTimeout(r, 800));
    const msgs = await axios.get(`${base}/api/v1/accounts/${accountId}/conversations/${convId}/messages`, { headers, timeout: 5000 });
    const replies = (msgs.data?.payload || []).filter(m => m.message_type === 1 || m.message_type === 'outgoing');
    const lastReply = replies[replies.length - 1]?.content || 'How can I assist you?';

    return { response: lastReply, bot_type: 'chatwoot', intent: null, confidence: 0.9 };
  } catch (e) {
    log.warn('Chatwoot error: %s', e.message);
    return { response: 'Please hold on a moment.', bot_type: 'chatwoot', error: e.message };
  }
}

// ── Dialogflow CX ─────────────────────────────────────────────
async function processWithDialogflow(cfg, callId, utterance, lang, session, t0) {
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth   = new GoogleAuth({ keyFile: cfg.gcp_key_file, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token  = await client.getAccessToken();

    const projectId = cfg.gcp_project_id;
    const agentId   = cfg.dialogflow_agent_id;
    const location  = cfg.dialogflow_location || 'us-central1';
    const sessionId = session.context.df_session_id || callId;
    session.context.df_session_id = sessionId;

    const url = `https://${location}-dialogflow.googleapis.com/v3/projects/${projectId}/locations/${location}/agents/${agentId}/sessions/${sessionId}:detectIntent`;
    const r = await axios.post(url, {
      queryInput: { text: { text: utterance }, languageCode: lang || 'en' },
    }, { headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' }, timeout: 8000 });

    const qr       = r.data?.queryResult;
    const response  = qr?.responseMessages?.map(m => m.text?.text?.[0]).filter(Boolean).join(' ') || 'How can I help?';
    const intent    = qr?.intent?.displayName;
    const confidence= qr?.intentDetectionConfidence || 0;

    return { response, intent, confidence, bot_type: 'dialogflow', raw: qr };
  } catch (e) {
    log.warn('Dialogflow CX error: %s', e.message);
    return { response: 'Let me look into that for you.', bot_type: 'dialogflow', error: e.message };
  }
}

// ── IBM Watson Assistant ──────────────────────────────────────
async function processWithWatson(cfg, callId, utterance, lang, session, t0) {
  try {
    const url     = `${cfg.watson_url}/v2/assistants/${cfg.watson_assistant_id}/sessions`;
    const auth    = { username: 'apikey', password: cfg.watson_api_key };

    // Create session if needed
    if (!session.context.watson_session_id) {
      const s = await axios.post(`${url}?version=2023-06-15`, {}, { auth, timeout: 5000 });
      session.context.watson_session_id = s.data.session_id;
    }

    const r = await axios.post(
      `${url}/${session.context.watson_session_id}/message?version=2023-06-15`,
      { input: { message_type: 'text', text: utterance }, context: { skills: { 'main skill': { user_defined: { lang } } } } },
      { auth, timeout: 8000 }
    );

    const output   = r.data?.output;
    const response = output?.generic?.map(g => g.text).filter(Boolean).join(' ') || 'How may I assist you?';
    const intent   = output?.intents?.[0]?.intent;
    const confidence = output?.intents?.[0]?.confidence || 0;

    return { response, intent, confidence, bot_type: 'watson', raw: output };
  } catch (e) {
    log.warn('Watson error: %s', e.message);
    return { response: 'One moment please.', bot_type: 'watson', error: e.message };
  }
}

// ── Amazon Lex v2 ─────────────────────────────────────────────
async function processWithLex(cfg, callId, utterance, lang, session, t0) {
  try {
    const { LexRuntimeV2Client, RecognizeTextCommand } = require('@aws-sdk/client-lex-runtime-v2');
    const client = new LexRuntimeV2Client({
      region: cfg.aws_region || 'us-east-1',
      credentials: { accessKeyId: cfg.aws_access_key, secretAccessKey: cfg.aws_secret_key },
    });
    const r = await client.send(new RecognizeTextCommand({
      botId: cfg.lex_bot_id, botAliasId: cfg.lex_bot_alias_id || 'TSTALIASID',
      localeId: cfg.lex_locale || 'en_US', sessionId: callId,
      text: utterance,
    }));

    const messages = r.messages || [];
    const response = messages.map(m => m.content).filter(Boolean).join(' ') || 'How can I help you today?';
    const intent   = r.sessionState?.intent?.name;
    const confidence = 0.9;

    return { response, intent, confidence, bot_type: 'lex', raw: r };
  } catch (e) {
    log.warn('Amazon Lex error: %s', e.message);
    return { response: 'Just a moment, please.', bot_type: 'lex', error: e.message };
  }
}

// ── Microsoft Bot Framework ───────────────────────────────────
async function processWithBotFramework(cfg, callId, utterance, lang, session, t0) {
  try {
    // Get token
    const tok = await axios.post('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.ms_app_id, client_secret: cfg.ms_app_password, scope: 'https://api.botframework.com/.default' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 }
    );

    const r = await axios.post(`${cfg.ms_bot_endpoint}/api/messages`, {
      type: 'message', id: callId, timestamp: new Date().toISOString(),
      text: utterance, locale: lang,
      from: { id: session.context.caller_num || 'caller', name: 'Caller' },
      conversation: { id: callId },
      recipient: { id: cfg.ms_app_id, name: 'VoiceBot' },
    }, { headers: { Authorization: `Bearer ${tok.data.access_token}`, 'Content-Type': 'application/json' }, timeout: 8000 });

    const response = r.data?.text || r.data?.speak || 'How can I help you?';
    return { response, bot_type: 'botframework', intent: null, confidence: 0.9 };
  } catch (e) {
    log.warn('BotFramework error: %s', e.message);
    return { response: 'Please hold on.', bot_type: 'botframework', error: e.message };
  }
}

// ── GPT-4o with function calling ─────────────────────────────
async function processWithGPT4o(cfg, callId, utterance, lang, session, tenantId, t0) {
  try {
    const apiKey = cfg.openai_api_key || process.env.OPENAI_API_KEY;
    const tools  = cfg.gpt_tools || defaultTools(tenantId);
    const model  = cfg.gpt_model || 'gpt-4o-mini';
    const messages = [
      { role: 'system', content: `You are a professional call center voice agent for ${tenantId}. Caller language: ${lang}. Keep responses short (1-2 sentences). Be warm and helpful.` },
      ...session.history.slice(-10),
      { role: 'user', content: utterance },
    ];

    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model, messages, tools, tool_choice: 'auto', max_tokens: 200,
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 12000 });

    const choice  = r.data.choices?.[0];
    const msg     = choice?.message;
    let response  = msg?.content || '';
    let toolCalls = msg?.tool_calls || [];

    // Handle tool calls (e.g. order lookup)
    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      const toolResult = await executeTool(tenantId, tc.function.name, args);
      // Re-invoke with tool result
      messages.push(msg);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
      const r2 = await axios.post('https://api.openai.com/v1/chat/completions',
        { model, messages, max_tokens: 200 },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 });
      response = r2.data.choices?.[0]?.message?.content || response;
    }

    return { response: response || 'I understand. How can I assist you further?', bot_type: 'gpt4o', intent: null, confidence: 0.9 };
  } catch (e) {
    log.warn('GPT-4o error: %s', e.message);
    return { response: 'Let me help you with that.', bot_type: 'gpt4o', error: e.message };
  }
}

// ── Claude AI native ──────────────────────────────────────────
async function processWithClaude(tenantId, callId, utterance, lang, session, cfg, t0) {
  try {
    const apiKey = cfg?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    const model  = cfg?.model || 'claude-sonnet-4-20250514';
    const system = `You are a professional multilingual voice call center agent for ${tenantId}.
Caller language: ${require('../ai/client').LANG_NAMES[lang] || lang}. Call ID: ${callId}.
Rules: Keep replies SHORT (1-2 sentences max). Warm, professional tone. Respond in English unless asked otherwise.
For orders/billing: acknowledge you have their account open. Offer to transfer if complex.`;

    const messages = [...session.history.slice(-12), { role: 'user', content: utterance }];
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens: 200, system, messages,
    }, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 15000 });

    const response = r.data.content?.[0]?.text || 'How can I help you today?';
    return { response, bot_type: 'claude', intent: null, confidence: 0.95,
             tokens_in: r.data.usage?.input_tokens || 0, tokens_out: r.data.usage?.output_tokens || 0 };
  } catch (e) {
    log.warn('Claude bot error: %s', e.message);
    return { response: 'I\'m here to help. Could you please repeat that?', bot_type: 'claude', error: e.message };
  }
}

// ── Custom HTTP bot ───────────────────────────────────────────
async function processWithCustom(cfg, callId, utterance, lang, session, tenantId, t0) {
  try {
    const payload = {
      tenant_id: tenantId, call_id: callId,
      transcript: utterance, translated: utterance,
      caller_lang: lang, caller_num: session.context.caller_num,
      session_id: `sess_${callId.slice(0, 8)}`,
      turn: session.turnCount,
      history: session.history.slice(-10),
      context: session.context,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.custom_auth_header) headers[cfg.custom_auth_header] = cfg.custom_auth_value || '';
    if (cfg.custom_api_key)     headers['Authorization'] = `Bearer ${cfg.custom_api_key}`;

    const r = await axios.post(cfg.custom_url, payload, { headers, timeout: cfg.timeout_ms || 6000 });

    // Accept various response formats
    const data     = r.data || {};
    const response = data.response || data.text || data.message || data.reply || data.output || JSON.stringify(data);
    const intent   = data.intent || data.action || null;
    const confidence = data.confidence || data.score || 0.9;
    const escalate = data.escalate || data.transfer || false;

    return { response, intent, confidence, bot_type: 'custom', escalate, raw: data };
  } catch (e) {
    log.warn('Custom bot error [%s]: %s', cfg.custom_url, e.message);
    return { response: 'Please hold on a moment.', bot_type: 'custom', error: e.message };
  }
}

// ── GPT-4o function tools ─────────────────────────────────────
function defaultTools(tenantId) {
  return [
    { type: 'function', function: { name: 'lookup_order', description: 'Look up an order by order ID', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } },
    { type: 'function', function: { name: 'get_account',  description: 'Get customer account info',   parameters: { type: 'object', properties: { phone: { type: 'string' } }, required: [] } } },
    { type: 'function', function: { name: 'transfer_to_agent', description: 'Transfer call to human agent', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    { type: 'function', function: { name: 'book_appointment', description: 'Book a new appointment', parameters: { type: 'object', properties: { date: { type: 'string' }, time: { type: 'string' } }, required: ['date', 'time'] } } },
  ];
}

async function executeTool(tenantId, toolName, args) {
  try {
    switch (toolName) {
      case 'lookup_order': {
        const doc = await db.get(db.tdb(tenantId, 'orders'), `order_${args.order_id}`);
        return doc || { error: 'Order not found', order_id: args.order_id };
      }
      case 'get_account': {
        const users = await db.findDocs(db.tdb(tenantId, 'agents'), {}, null, 5);
        return { account: users[0] || null };
      }
      case 'transfer_to_agent': return { action: 'transfer', reason: args.reason };
      case 'book_appointment':  return { booked: true, date: args.date, time: args.time, confirmation: 'APT-' + Date.now().toString(36).toUpperCase() };
      default: return { error: 'Unknown tool' };
    }
  } catch (e) { return { error: e.message }; }
}

// ── Escalation logic ──────────────────────────────────────────
function checkEscalation(result, session, cfg) {
  const rules = cfg?.escalation_rules || {};
  const { intent, confidence, response } = result;
  const lowerResponse = (response || '').toLowerCase();
  const lowerHistory  = session.history.map(h => h.content || '').join(' ').toLowerCase();

  // Explicit transfer intent
  if (intent && ['speak_to_agent','transfer','human','escalate','manager'].some(k => intent.includes(k))) return 'intent_transfer';
  // Caller words
  if (/\b(agent|human|manager|supervisor|person|representative|real person)\b/i.test(session.history.slice(-2).map(h=>h.content).join(' '))) return 'caller_requested_human';
  // Low confidence
  if (confidence > 0 && confidence < (rules.min_confidence || 0.55)) return 'low_confidence';
  // Too many turns without resolution
  if (session.turnCount >= (rules.max_turns || 8)) return 'max_turns_reached';
  // Frustration keywords
  if (rules.detect_frustration !== false && /\b(angry|furious|unacceptable|ridiculous|useless|terrible|awful|this is ridiculous)\b/i.test(lowerHistory)) return 'frustration_detected';
  // Custom trigger
  if (result.escalate) return 'bot_requested_transfer';
  return null;
}

function buildBrief(session, lastUtterance) {
  const recent = session.history.slice(-4).map(h => `${h.role}: ${h.content}`).join(' | ');
  return `VoiceBot transfer. ${session.turnCount} turns. Last: "${lastUtterance}". Context: ${recent}`;
}

module.exports = { processUtterance, getBotConfig, getSession, endSession, buildBrief };
