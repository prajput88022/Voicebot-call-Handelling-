#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { initCouchDB, listTenants } = require('../src/db/couch');
const db = require('../src/db/couch');

(async () => {
  await initCouchDB();
  const tenants = await listTenants();
  if (!tenants.length) { console.log('No tenants found. Run setup-db.js first.'); process.exit(0); }
  const t = tenants[0];
  console.log('Seeding demo data for tenant:', t._id);

  // Demo orders
  const orders = [
    { order_id:'88421', customer:'Carlos Ruiz', status:'in_transit', carrier:'DHL', tracking:'DHL123456', eta:'2025-05-17', items:[{name:'Laptop',qty:1,price:999}] },
    { order_id:'88422', customer:'Priya Singh', status:'delivered',  carrier:'FedEx',tracking:'FDX789012', eta:'2025-05-15', items:[{name:'Phone',qty:2,price:599}] },
    { order_id:'88423', customer:'John Smith',  status:'processing', carrier:null,   tracking:null,         eta:'2025-05-20', items:[{name:'Tablet',qty:1,price:449}] },
  ];
  for (const o of orders) {
    const doc = { _id:'order_'+o.order_id, type:'order', ...o, created_at:new Date().toISOString() };
    await db.save(db.tdb(t._id,'orders'), doc).catch(()=>{});
    console.log('  Order', o.order_id);
  }

  // Demo CDR records
  const callers = ['+34612345678','+919812345678','+12025551234','+447911123456','+4915123456789'];
  const langs   = ['es','hi','en','en','de'];
  const agents  = (await db.listAllDocs(db.tdb(t._id,'agents'))).filter(u=>u&&u.role==='agent');
  for (let i=0; i<20; i++) {
    const dur = Math.floor(Math.random()*300+60);
    const wait= Math.floor(Math.random()*30+5);
    const disp= Math.random()>0.08?'ANSWERED':(Math.random()>0.5?'NO ANSWER':'ABANDONED');
    const start = new Date(Date.now() - Math.floor(Math.random()*7*86400000));
    await db.saveCDR(t._id, {
      call_id: 'demo_'+i, start_time: start.toISOString(),
      end_time: new Date(start.getTime()+(dur+wait)*1000).toISOString(),
      duration_sec: disp==='ANSWERED'?dur:0, wait_sec:wait,
      caller_num: callers[i%5], caller_lang: langs[i%5],
      agent_id: agents[i%Math.max(agents.length,1)]?._id,
      queue: ['Support','Billing','Sales'][i%3],
      disposition: disp, pbx: t.settings?.default_asr||'asterisk',
    });
  }
  console.log('  20 CDR records');

  // Demo CSAT
  for (let i=0; i<15; i++) {
    await db.saveCSAT(t._id, {
      call_id: 'demo_'+i, rating: Math.floor(Math.random()*2+3)+1,
      agent_id: agents[i%Math.max(agents.length,1)]?._id,
      comment: ['Great service!','Very helpful','Quick response','Could be better','Excellent!'][i%5],
    });
  }
  console.log('  15 CSAT records');

  console.log('\nSeed complete.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
