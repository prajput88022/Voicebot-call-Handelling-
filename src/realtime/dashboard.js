'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { createLogger } = require('../core/logger');
const db      = require('../db/couch');
const { sessions } = require('./ws-bridge');
const reports = require('../reports/engine');

const log = createLogger('dashboard');

async function startDash(port) {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin:'*' } });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../../public')));

  app.get('/dash/stats/:tenantId', async (req, res) => {
    const s = await reports.getDashboardSummary(req.params.tenantId).catch(() => ({}));
    res.json(s);
  });

  io.on('connection', socket => {
    socket.on('join_tenant', async (tenantId) => {
      socket.join('t_' + tenantId);
      const active = [...sessions.entries()].filter(([,s]) => s.tenantId===tenantId).map(([id,s]) => ({ call_id:id, pbx:s.pbxType, duration:Math.round((Date.now()-s.started)/1000) }));
      socket.emit('active_sessions', active);
      const summary = await reports.getDashboardSummary(tenantId).catch(() => ({}));
      socket.emit('dashboard_summary', summary);
    });

    socket.on('agent_reply', data => {
      const sess = sessions.get(data.call_id);
      if (sess?.ws?.readyState === 1) sess.ws.send(JSON.stringify({ type:'agent_reply', ...data }));
      io.to('t_' + data.tenant_id).emit('agent_replied', data);
    });
  });

  // Broadcast WS bridge events to dashboard clients
  const origEmit = require('events').EventEmitter.prototype.emit;
  global.broadcastToTenant = (tenantId, event, data) => {
    io.to('t_' + tenantId).emit(event, data);
  };

  await new Promise(r => server.listen(port, '0.0.0.0', r));
  log.info('Dashboard on http://0.0.0.0:%d', port);
  return server;
}

module.exports = { startDash };
