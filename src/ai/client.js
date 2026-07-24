'use strict';
const axios = require('axios');
const { createLogger } = require('../core/logger');
const log = createLogger('ai');

const LANG_NAMES = {
  en:'English', es:'Spanish', hi:'Hindi', fr:'French', ar:'Arabic',
  zh:'Chinese', de:'German', pt:'Portuguese', ru:'Russian', ja:'Japanese',
  ko:'Korean', it:'Italian', tr:'Turkish', nl:'Dutch', pl:'Polish',
  uk:'Ukrainian', vi:'Vietnamese', th:'Thai', id:'Indonesian', sw:'Swahili',
  bn:'Bengali', ur:'Urdu', ta:'Tamil',
};
const AZURE_VOICES = {
  en:'en-US-JennyNeural', es:'es-ES-ElviraNeural', hi:'hi-IN-SwaraNeural',
  fr:'fr-FR-DeniseNeural', ar:'ar-SA-ZariyahNeural', de:'de-DE-KatjaNeural',
  zh:'zh-CN-XiaoxiaoNeural', pt:'pt-BR-FranciscaNeural', ru:'ru-RU-SvetlanaNeural',
  ja:'ja-JP-NanamiNeural', ko:'ko-KR-SunHiNeural', it:'it-IT-ElsaNeural',
};

async function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return { lang:'hi', confidence:0.9 };
  if (/[\u0600-\u06FF]/.test(text)) return { lang:'ar', confidence:0.9 };
  if (/[\u4E00-\u9FFF]/.test(text)) return { lang:'zh', confidence:0.9 };
  if (/[\u3040-\u30FF]/.test(text)) return { lang:'ja', confidence:0.9 };
  if (/[\uAC00-\uD7AF]/.test(text)) return { lang:'ko', confidence:0.9 };
  if (/[\u0400-\u04FF]/.test(text)) return { lang:'ru', confidence:0.9 };
  if (/\b(hola|gracias|necesito|ayuda|pedido)\b/i.test(text)) return { lang:'es', confidence:0.85 };
  if (/\b(bonjour|merci|besoin|commande)\b/i.test(text)) return { lang:'fr', confidence:0.85 };
  if (/\b(danke|bitte|brauche|bestellung)\b/i.test(text)) return { lang:'de', confidence:0.85 };
  const ltUrl = process.env.LIBRETRANSLATE_URL;
  if (ltUrl) {
    try {
      const r = await axios.post(`${ltUrl}/detect`, { q: text }, { timeout: 3000 });
      if (r.data?.[0]) return { lang: r.data[0].language, confidence: r.data[0].confidence };
    } catch {}
  }
  return { lang:'en', confidence:0.6 };
}

async function translate(text, sourceLang, targetLang = 'en', vendor = null) {
  if (!text) return { text, engine:'none', chars:0 };
  const src = (sourceLang||'en').slice(0,2).toLowerCase();
  const tgt = (targetLang||'en').slice(0,2).toLowerCase();
  if (src === tgt) return { text, engine:'none', chars:0 };
  const chars = text.length;
  const v = vendor || (process.env.DEEPL_API_KEY ? 'deepl' : process.env.AZURE_TRANSLATOR_KEY ? 'azure' : 'libretranslate');

  if (v === 'deepl' && process.env.DEEPL_API_KEY) {
    try {
      const isFree = process.env.DEEPL_API_KEY.endsWith(':fx');
      const url = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
      const r = await axios.post(url, new URLSearchParams({ auth_key: process.env.DEEPL_API_KEY, text, source_lang: src.toUpperCase(), target_lang: tgt.toUpperCase() }), { timeout: 6000 });
      const t = r.data.translations?.[0]?.text;
      if (t) return { text: t, engine:'deepl', chars };
    } catch (e) { log.warn('DeepL: %s', e.message); }
  }
  if (v === 'azure' && process.env.AZURE_TRANSLATOR_KEY) {
    try {
      const r = await axios.post(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${src}&to=${tgt}`, [{ Text: text }], {
        headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY, 'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION||'eastus', 'Content-Type':'application/json' }, timeout: 6000 });
      const t = r.data?.[0]?.translations?.[0]?.text;
      if (t) return { text: t, engine:'azure', chars };
    } catch (e) { log.warn('Azure Trans: %s', e.message); }
  }
  try {
    const url = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.de';
    const r = await axios.post(`${url}/translate`, { q: text, source: src, target: tgt, format:'text', api_key: process.env.LIBRETRANSLATE_KEY||'' }, { timeout: 6000 });
    const t = r.data?.translatedText;
    if (t) return { text: t, engine:'libretranslate', chars };
  } catch {}
  return { text, engine:'none', chars };
}

async function llmChat(messages, systemPrompt, vendor = null) {
  const v = vendor || (process.env.ANTHROPIC_API_KEY ? 'claude_sonnet' : process.env.OPENAI_API_KEY ? 'gpt4o_mini' : 'mock');
  const t0 = Date.now();

  if (v.startsWith('claude') && process.env.ANTHROPIC_API_KEY) {
    try {
      const model = v === 'claude_haiku' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model, max_tokens: 300, system: systemPrompt, messages: messages.slice(-12) },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' }, timeout: 15000 });
      return { text: r.data.content?.[0]?.text||'', vendor:v, tokens_in: r.data.usage?.input_tokens||0, tokens_out: r.data.usage?.output_tokens||0, ms: Date.now()-t0 };
    } catch (e) { log.warn('Claude: %s', e.message); }
  }
  if ((v.startsWith('gpt')||v==='openai') && process.env.OPENAI_API_KEY) {
    try {
      const model = v==='gpt4o' ? 'gpt-4o' : 'gpt-4o-mini';
      const r = await axios.post('https://api.openai.com/v1/chat/completions',
        { model, messages:[{role:'system',content:systemPrompt},...messages.slice(-10)], max_tokens:300 },
        { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' }, timeout:15000 });
      return { text: r.data.choices?.[0]?.message?.content||'', vendor:v, tokens_in: r.data.usage?.prompt_tokens||0, tokens_out: r.data.usage?.completion_tokens||0, ms: Date.now()-t0 };
    } catch (e) { log.warn('OpenAI: %s', e.message); }
  }
  if (v==='deepseek' && process.env.DEEPSEEK_API_KEY) {
    try {
      const r = await axios.post('https://api.deepseek.com/chat/completions',
        { model:'deepseek-chat', messages:[{role:'system',content:systemPrompt},...messages.slice(-10)], max_tokens:300 },
        { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type':'application/json' }, timeout:15000 });
      return { text: r.data.choices?.[0]?.message?.content||'', vendor:v, tokens_in:0, tokens_out:0, ms:Date.now()-t0 };
    } catch (e) { log.warn('DeepSeek: %s', e.message); }
  }
  return { text:'I understand. Let me assist you right away.', vendor:'mock', tokens_in:0, tokens_out:20, ms:10 };
}

async function synthesize(text, lang = 'en', vendor = null) {
  if (!text) return null;
  const langCode = (lang||'en').slice(0,2).toLowerCase();
  const v = vendor || (process.env.AZURE_TTS_KEY ? 'azure' : process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'espeak');

  if (v==='azure' && process.env.AZURE_TTS_KEY) {
    try {
      const voice = AZURE_VOICES[langCode]||'en-US-JennyNeural';
      const ssml = `<speak version='1.0' xml:lang='${langCode}'><voice name='${voice}'>${text}</voice></speak>`;
      const tok = await axios.post(`https://${process.env.AZURE_TTS_REGION||'eastus'}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, null, { headers:{'Ocp-Apim-Subscription-Key':process.env.AZURE_TTS_KEY} });
      const audio = await axios.post(`https://${process.env.AZURE_TTS_REGION||'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`, ssml, {
        headers:{ Authorization:`Bearer ${tok.data}`, 'Content-Type':'application/ssml+xml', 'X-Microsoft-OutputFormat':'raw-16khz-16bit-mono-pcm' }, responseType:'arraybuffer', timeout:10000 });
      return Buffer.from(audio.data);
    } catch (e) { log.warn('Azure TTS: %s', e.message); }
  }
  if (v==='elevenlabs' && process.env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = process.env.ELEVENLABS_VOICE_ID||'EXAVITQu4vr4xnSDxMaL';
      const r = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text, model_id:'eleven_multilingual_v2', voice_settings:{stability:0.5,similarity_boost:0.75} },
        { headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY,'Content-Type':'application/json',Accept:'audio/mpeg'}, responseType:'arraybuffer', timeout:12000 });
      return Buffer.from(r.data);
    } catch (e) { log.warn('ElevenLabs: %s', e.message); }
  }
  return null;
}

async function callCenterRespond({ history, callerLang, callId, tenantId, vendor, agentName, orderCtx }) {
  const order = orderCtx ? `\nOrder: ${JSON.stringify(orderCtx)}` : '';
  const system = `You are ${agentName||'VoiceBridge AI'} — multilingual call center agent for ${tenantId}.
Caller language: ${LANG_NAMES[callerLang]||callerLang}. Call ID: ${callId}.${order}
Rules: SHORT replies (2-3 sentences). Warm, professional. Respond in English.
For order/billing queries, acknowledge you have their account open.`;
  return llmChat(history, system, vendor);
}

module.exports = { detectLanguage, translate, llmChat, synthesize, callCenterRespond, LANG_NAMES, AZURE_VOICES };
