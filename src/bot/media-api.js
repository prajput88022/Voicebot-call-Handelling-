'use strict';
const express = require('express');
const auth = require('../api/middleware/auth');
const { saveAudio } = require('./media');
const db = require('../db/couch');
const { createLogger } = require('../core/logger');
const log = createLogger('bot-media-api');

const router = express.Router({ mergeParams: true });

// Upload base64 audio for a campaign
router.post('/campaigns/:id/media', auth.requireAdmin, async (req, res) => {
  try {
    const tid = req.params.tenantId;
    const campaignId = req.params.id;
    const { filename, base64 } = req.body;
    if (!filename || !base64) return res.status(400).json({ error: 'filename and base64 required' });
    // verify campaign exists
    const camp = await db.get(db.tdb(tid, 'config'), campaignId).catch(() => null);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });
    const publicPath = await saveAudio(tid, filename, base64);
    // attach to campaign (store as campaign-level audio)
    await db.update(db.tdb(tid, 'config'), campaignId, { audio_file: publicPath });
    res.json({ ok: true, audio_file: publicPath });
  } catch (e) { log.error(e); res.status(500).json({ error: e.message }); }
});

// List media files for a tenant (under public/media/<tenantId>)
router.get('/media', auth.requireTenantAccess, async (req, res) => {
  try {
    const tid = req.params.tenantId;
    const dir = require('path').join(__dirname, '..', '..', 'public', 'media', tid);
    const files = await require('fs').promises.readdir(dir).catch(()=>[]);
    const paths = files.map(f => `/media/${tid}/${f}`);
    res.json({ files: paths });
  } catch (e) { log.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
