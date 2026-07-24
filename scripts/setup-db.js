#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { initCouchDB, createTenant, listTenants, G } = require('../src/db/couch');
const bcrypt = require('bcryptjs');
const { v4 } = require('uuid');

(async () => {
  console.log('Setting up CouchDB…');
  await initCouchDB();

  // Superadmin
  const email = process.env.SUPERADMIN_EMAIL || 'superadmin@techlife.ai';
  const pass  = process.env.SUPERADMIN_PASS  || 'SuperAdmin@2024';
  const nano  = require('nano')(process.env.COUCH_URL || 'http://admin:password@127.0.0.1:5984');
  const saDb  = nano.use('vb_superadmins');
  const existing = await saDb.find({ selector:{ email } }).catch(() => ({ docs:[] }));
  if (!existing.docs.length) {
    await saDb.insert({ _id:'sa_'+v4(), type:'superadmin', email, password_hash: await bcrypt.hash(pass, 12), name:'Super Admin', created_at:new Date().toISOString() });
    console.log('Superadmin created:', email, '/', pass);
  } else {
    console.log('Superadmin already exists:', email);
  }

  // Demo tenant
  const tenants = await listTenants();
  if (!tenants.length) {
    console.log('Creating demo tenant…');
    const id = await createTenant({ name:'Demo Corp', email:'admin@democorp.com', plan:'professional', languages:['en','hi','es'], asr:'whisper', llm:'claude_sonnet', tts:'azure', trans:'deepl' });
    const { createUser } = require('../src/tenant/manager');
    await createUser(id, { name:'Admin User',  email:'admin@democorp.com',   password:'Admin@1234',  role:'admin',      exten:'1001', languages:['en','hi'] });
    await createUser(id, { name:'Priya Sharma',email:'priya@democorp.com',   password:'Agent@1234',  role:'supervisor', exten:'1002', languages:['en','hi'] });
    await createUser(id, { name:'Raj Kumar',   email:'raj@democorp.com',     password:'Agent@1234',  role:'agent',      exten:'1003', languages:['en'] });
    await createUser(id, { name:'Ana Garcia',  email:'ana@democorp.com',     password:'Agent@1234',  role:'agent',      exten:'1004', languages:['en','es'] });
    console.log('Demo tenant created:', id);
    console.log('  admin@democorp.com / Admin@1234');
    console.log('  raj@democorp.com   / Agent@1234');
  }

  console.log('\nSetup complete.');
  process.exit(0);
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
