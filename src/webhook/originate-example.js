'use strict';
/**
 * Example lightweight PBX originate endpoint (for testing / demo only)
 *
 * Usage:
 *   node src/webhook/originate-example.js
 *
 * This example implements a small HTTP server that accepts POST /originate
 * with the originate payload the platform sends. It demonstrates how a PBX
 * or bridge might react to the hints in the payload (play_audio, tts_text)
 * by downloading the file and optionally POSTing back a simple call event
 * to a callback URL provided in the originate body.
 *
 * NOTE: This is a demonstration helper — a real PBX (Asterisk, FreeSWITCH)
 * will use channel/media APIs to play audio, not HTTP downloads. Use this
 * only for local dev or to understand the expected payload shape.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createLogger } = require('../core/logger');
const log = createLogger('originate-example');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/originate', async (req, res) => {
  try {
    const payload = req.body || {};
    const { tenant_id, campaign_id, call_id, from, to, play_audio, tts_text, tts_voice, callback_url } = payload;
    log.info('Originate request: %s -> %s (call_id=%s) play_audio=%s tts_text=%s', from, to, call_id, !!play_audio, !!tts_text);

    // Save the raw payload for inspection
    const logsDir = path.join(__dirname, '..', '..', 'tmp', 'originate_logs');
    await fs.promises.mkdir(logsDir, { recursive: true });
    const file = path.join(logsDir, `${Date.now()}_${tenant_id || 't'}_${call_id || 'call'}.json`);
    await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));

    // If play_audio is a public path (served by platform), download it for demo
    if (play_audio) {
      try {
        const url = play_audio.startsWith('http') ? play_audio : `${req.protocol}://${req.get('host')}${play_audio}`;
        log.info('Downloading audio for demo: %s', url);
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 }).catch(e => { throw e; });
        const outDir = path.join(__dirname, '..', '..', 'tmp', 'originate_audio');
        await fs.promises.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `${tenant_id || 't'}_${campaign_id || 'c'}_${call_id || Date.now()}.wav`);
        await fs.promises.writeFile(outPath, Buffer.from(r.data));
        log.info('Saved demo audio to %s', outPath);
      } catch (e) {
        log.warn('Could not download play_audio: %s', e.message);
      }
    } else if (tts_text) {
      log.info('TTs text provided (demo): "%s" — tts_voice=%s', tts_text, tts_voice);
      // In a production PBX, you would either pre-fetch the pre-generated file or call the TTS provider
    }

    // Reply immediately to acknowledge originate request
    res.json({ ok: true, received: true });

    // Demo: simulate an answer event after a short delay and POST to callback_url if provided
    if (callback_url) {
      setTimeout(async () => {
        try {
          const event = { event: 'call.answered', tenant_id, campaign_id, call_id, from, to, played: !!play_audio };
          await axios.post(callback_url, event, { timeout: 5000 }).catch(e => { throw e; });
          log.info('Posted callback to %s', callback_url);
        } catch (e) { log.warn('Callback failed: %s', e.message); }
      }, 2000);
    } else {
      log.info('No callback_url provided — example PBX will not post answer events back.');
    }
  } catch (e) {
    log.error('Originate handler error: %s', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.ORIGINATE_EXAMPLE_PORT || 5001;
app.listen(PORT, () => log.info('Originate example server listening on %d', PORT));

module.exports = app;
