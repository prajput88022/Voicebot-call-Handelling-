'use strict';
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function sign(payload, expiresIn = process.env.JWT_EXPIRES || '12h') {
  return jwt.sign(payload, SECRET, { expiresIn });
}
function verify(token) { return jwt.verify(token, SECRET); }

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try { req.user = verify(h.slice(7)); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin required' });
    next();
  });
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!['superadmin','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin required' });
    const tid = req.params.tenantId;
    if (req.user.role !== 'superadmin' && tid && tid !== req.user.tenant_id)
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    req.tenantId = tid || req.user.tenant_id;
    next();
  });
}
function requireTenantAccess(req, res, next) {
  requireAuth(req, res, () => {
    const tid = req.params.tenantId || req.user.tenant_id;
    if (req.user.role !== 'superadmin' && tid && tid !== req.user.tenant_id)
      return res.status(403).json({ error: 'Tenant access denied' });
    req.tenantId = tid || req.user.tenant_id;
    next();
  });
}
module.exports = { sign, verify, requireAuth, requireSuperAdmin, requireAdmin, requireTenantAccess };
