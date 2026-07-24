'use strict';
const winston = require('winston');
const DRF     = require('winston-daily-rotate-file');
const fs      = require('fs');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Fall back to a local ./logs directory if the configured LOG_DIR (default
// /var/log/techlife) isn't writable — e.g. running as a non-root user during
// local development/testing instead of via the systemd service as www-data.
let LOG_DIR = process.env.LOG_DIR || '/var/log/techlife';
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.accessSync(LOG_DIR, fs.constants.W_OK);
} catch {
  const fallback = require('path').join(process.cwd(), 'logs');
  try {
    fs.mkdirSync(fallback, { recursive: true });
    console.warn(`[logger] LOG_DIR "${LOG_DIR}" is not writable — falling back to "${fallback}". Fix permissions (chown/chmod) or set LOG_DIR in .env to a writable path.`);
    LOG_DIR = fallback;
  } catch {
    console.warn(`[logger] Could not create any log directory — file logging disabled, console logging only.`);
  }
}

const consoleFmt = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, label, message }) =>
    `${timestamp} ${level} ${label ? '[' + label + ']' : ''} ${message}`)
);
const fileFmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, label, message, stack }) =>
    `${timestamp} ${level.toUpperCase().padEnd(5)} ${label ? '[' + label + ']' : ''} ${message}${stack ? '\n' + stack : ''}`)
);

function createLogger(label = 'app') {
  return winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta: { label },
    transports: [
      new winston.transports.Console({ format: consoleFmt }),
      new DRF({ dirname: LOG_DIR, filename: 'vb-%DATE%.log', datePattern: 'YYYY-MM-DD', maxFiles: '30d', format: fileFmt }),
    ],
  });
}
module.exports = { createLogger };
