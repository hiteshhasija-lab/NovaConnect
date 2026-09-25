'use strict';

const pino = require('pino');
const { getTracer } = require('./telemetry');

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_PRETTY = NODE_ENV !== 'production';

const baseLogger = pino({
  level: LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'novaconnect',
    version: process.env.NOVACONNECT_RELEASE_VERSION || process.env.npm_package_version || 'dev',
    environment: NODE_ENV,
    hostname: require('os').hostname(),
    pid: process.pid,
  },
  mixin: () => {
    const span = getTracer('novaconnect').getSpan?.() || require('@opentelemetry/api').trace.getSpan(require('@opentelemetry/api').context.active());
    if (span?.spanContext) {
      const ctx = span.spanContext();
      return {
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
      };
    }
    return {};
  },
}, LOG_PRETTY ? pino.destination({ dest: 1, sync: false }) : process.stdout);

function createChildLogger(bindings) {
  return baseLogger.child(bindings);
}

function createRequestLogger(req, res) {
  const requestId = req.headers?.['x-request-id'] || req.id || require('crypto').randomUUID();
  const tracer = getTracer('novaconnect');

  return baseLogger.child({
    request_id: requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    user_agent: req.headers?.['user-agent'],
    ip: req.ip || req.connection?.remoteAddress,
    trace_id: undefined, // will be filled by mixin if span is active
    span_id: undefined,
  });
}

module.exports = {
  logger: baseLogger,
  createChildLogger,
  createRequestLogger,
  levels: pino.levels,
};