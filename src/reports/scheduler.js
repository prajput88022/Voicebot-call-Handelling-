'use strict';
const cron = require('node-cron');
const { createLogger } = require('../core/logger');
const db = require('../db/couch');
const { getCDR, getACDReport, getCSATReport, getBillingReport, deliverReport } = require('./engine');
const log = createLogger('scheduler');

function scheduleReports() {
  // Daily CDR @ 08:00
  cron.schedule('0 8 * * *', async () => {
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    log.info('Running daily CDR reports…');
    const tenants = await db.listTenants();
    for (const t of tenants) {
      try {
        const [cdr, acd] = await Promise.all([getCDR(t._id, yesterday, yesterday), getACDReport(t._id, yesterday, yesterday)]);
        const cfg = await db.get(db.tdb(t._id,'config'), 'report_schedule').catch(()=>null);
        if (cfg?.deliveries) for (const d of cfg.deliveries) await deliverReport(t._id, { type:'daily_cdr', date:yesterday, cdr:cdr.summary, acd }, d);
      } catch(e) { log.error('Daily CDR [%s]: %s', t._id, e.message); }
    }
  });

  // Weekly CSAT @ 08:00 Monday
  cron.schedule('0 8 * * 1', async () => {
    const now=new Date(), from=new Date(now.getTime()-7*86400000).toISOString().slice(0,10), to=now.toISOString().slice(0,10);
    log.info('Running weekly CSAT reports…');
    const tenants = await db.listTenants();
    for (const t of tenants) {
      try {
        const csat = await getCSATReport(t._id, from, to);
        const cfg = await db.get(db.tdb(t._id,'config'), 'report_schedule').catch(()=>null);
        if (cfg?.deliveries) for (const d of cfg.deliveries) await deliverReport(t._id, { type:'weekly_csat', period:{from,to}, csat }, d);
      } catch(e) { log.error('Weekly CSAT [%s]: %s', t._id, e.message); }
    }
  });

  // Monthly billing @ 09:00 on 1st
  cron.schedule('0 9 1 * *', async () => {
    const d=new Date(); d.setMonth(d.getMonth()-1);
    const month=d.toISOString().slice(0,7);
    log.info('Running monthly billing reports…');
    const tenants = await db.listTenants();
    for (const t of tenants) {
      try {
        const billing = await getBillingReport(t._id, month);
        const cfg = await db.get(db.tdb(t._id,'config'), 'report_schedule').catch(()=>null);
        if (cfg?.deliveries) for (const d2 of cfg.deliveries) await deliverReport(t._id, { type:'monthly_billing', month, billing }, d2);
      } catch(e) { log.error('Monthly billing [%s]: %s', t._id, e.message); }
    }
  });

  log.info('Report scheduler active');
}

module.exports = { scheduleReports };
