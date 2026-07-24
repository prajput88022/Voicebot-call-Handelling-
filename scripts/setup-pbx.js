#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIGS = path.join(__dirname, '../configs');
const SI = process.env.SERVER_IP  || '127.0.0.1';
const SD = process.env.SIP_DOMAIN || '127.0.0.1';

function cp(src, dst) { try { fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.copyFileSync(src,dst); console.log('  OK',dst); } catch(e){ console.log('  ERR',dst,e.message); } }
function patch(f) { try { let c=fs.readFileSync(f,'utf8'); c=c.replace(/SERVERIP/g,SI).replace(/SIPDOMAIN/g,SD); fs.writeFileSync(f,c); } catch {} }
function ex(cmd) { try { execSync(cmd,{stdio:'pipe'}); console.log('  OK',cmd); } catch(e){ console.log('  WARN',e.message?.slice(0,60)); } }

console.log('\nTechLife PBX Deploy\n');
if (fs.existsSync('/etc/asterisk')) {
  console.log('Asterisk:');
  cp(`${CONFIGS}/asterisk/pjsip.conf`,      '/etc/asterisk/pjsip.conf');
  cp(`${CONFIGS}/asterisk/extensions.conf`, '/etc/asterisk/extensions.conf');
  cp(`${CONFIGS}/asterisk/ari.conf`,        '/etc/asterisk/ari.conf');
  cp(`${CONFIGS}/asterisk/rtp.conf`,        '/etc/asterisk/rtp.conf');
  cp(`${CONFIGS}/asterisk/techlife_agi.py`, '/usr/share/asterisk/agi-bin/techlife_agi.py');
  ['/etc/asterisk/pjsip.conf','/etc/asterisk/extensions.conf'].forEach(patch);
  ex('chmod +x /usr/share/asterisk/agi-bin/techlife_agi.py');
  ex('asterisk -rx "core reload"');
}
if (fs.existsSync('/etc/freeswitch')) {
  console.log('\nFreeSWITCH:');
  cp(`${CONFIGS}/freeswitch/00_techlife_dialplan.xml`, '/etc/freeswitch/dialplan/default/00_techlife.xml');
  cp(`${CONFIGS}/freeswitch/event_socket.conf.xml`,    '/etc/freeswitch/autoload_configs/event_socket.conf.xml');
  ex('fs_cli -p ClueCon -x "reloadxml"');
}
if (fs.existsSync('/etc/kamailio')) {
  console.log('\nKamailio:');
  cp(`${CONFIGS}/kamailio/kamailio.cfg`,    '/etc/kamailio/kamailio.cfg');
  cp(`${CONFIGS}/kamailio/dispatcher.list`, '/etc/kamailio/dispatcher.list');
  patch('/etc/kamailio/kamailio.cfg');
  ex('systemctl restart kamailio');
}
if (fs.existsSync('/etc/nginx')) {
  console.log('\nNginx:');
  cp(`${CONFIGS}/nginx/techlife.conf`, '/etc/nginx/sites-available/techlife');
  ex('ln -sf /etc/nginx/sites-available/techlife /etc/nginx/sites-enabled/techlife');
  ex('nginx -t && systemctl reload nginx');
}
console.log('\nSystemd:');
cp(`${CONFIGS}/systemd/techlife-voicebridge.service`, '/etc/systemd/system/techlife-voicebridge.service');
ex('systemctl daemon-reload && systemctl enable techlife-voicebridge');
console.log('\nDone. Run: systemctl start techlife-voicebridge\n');
