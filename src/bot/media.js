'use strict';
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/logger');
const log = createLogger('bot-media');

// Save base64-encoded audio for a tenant under public/media/<tenantId>
async function saveAudio(tenantId, filename, base64Data) {
  const dir = path.join(__dirname, '..', '..', 'public', 'media', tenantId);
  await fs.promises.mkdir(dir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, safeName);
  const buf = Buffer.from(base64Data, 'base64');
  await fs.promises.writeFile(filePath, buf);
  log.info('Saved audio for tenant %s: %s', tenantId, safeName);
  // return a relative path that can be served by the dashboard/static server
  const publicPath = `/media/${tenantId}/${safeName}`;
  return publicPath;
}

module.exports = { saveAudio };
