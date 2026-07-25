'use strict';

require('dotenv').config();

const { createLogger } = require('./core/logger');
const { initCouchDB } = require('./db/couch');
const { startAPI } = require('./api/server');
const { startWS } = require('./realtime/ws-bridge');
const { startWebhook } = require('./webhook/server');
const { startDash } = require('./realtime/dashboard');
const { initBilling } = require('./billing/engine');
const { scheduleReports } = require('./reports/scheduler');

const log = createLogger('main');

async function main() {
  console.log(`
+--------------------------------------------------+
|  TechLife VoiceBridge Enterprise  v2.0.0          |
|  Multi-Tenant AI Call Center Platform             |
+--------------------------------------------------+
`);

  await initCouchDB();
  log.info('CouchDB ready');

  await initBilling();
  log.info('Billing engine ready');

  const apiPort = Number(process.env.API_PORT) || 4000;
  const wsPort = Number(process.env.WS_PORT) || 8765;
  const webhookPort = Number(process.env.WEBHOOK_PORT) || 5000;
  const dashboardPort = Number(process.env.DASHBOARD_PORT) || 3000;

  await startAPI(apiPort);
  log.info(`REST API   -> http://0.0.0.0:${apiPort}  (Swagger: /api-docs)`);

  await startWS(wsPort);
  log.info(`WS Bridge  -> ws://0.0.0.0:${wsPort}`);

  await startWebhook(webhookPort);
  log.info(`Webhooks   -> http://0.0.0.0:${webhookPort}`);

  await startDash(dashboardPort);
  log.info(`Dashboard  -> http://0.0.0.0:${dashboardPort}`);

  scheduleReports();
  log.info('Scheduler  -> CDR daily, CSAT weekly, Billing monthly');

  log.info('');
  log.info('--------------------------------------------------');
  log.info('TechLife VoiceBridge Enterprise is LIVE');
  log.info('--------------------------------------------------');
}

process.on('uncaughtException', (err) => {
  log.error('========== UNCAUGHT EXCEPTION ==========');
  log.error(err.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('========== UNHANDLED REJECTION ==========');
  log.error(reason instanceof Error ? reason.stack : reason);
});

main().catch((err) => {
  console.error('Fatal startup error:');
  console.error(err.stack || err);
  process.exit(1);
});