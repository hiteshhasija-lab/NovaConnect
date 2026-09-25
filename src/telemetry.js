'use strict';

const { getConfig } = require('./config');
const cfg = getConfig();

const { diag, DiagConsoleLogger, DiagLogLevel, trace } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis-4');
const { SocketIoInstrumentation } = require('@opentelemetry/instrumentation-socket.io');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const SERVICE_NAME = 'novaconnect';
const SERVICE_VERSION = process.env.NOVACONNECT_RELEASE_VERSION || process.env.npm_package_version || 'dev';
const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = cfg.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '';
const NODE_ENV = cfg.NODE_ENV;

let sdk = null;
let initialized = false;

function initTelemetry() {
  if (initialized) return trace.getTracerProvider();

  // Enable internal diagnostic logging in development
  if (NODE_ENV === 'development') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]: SERVICE_VERSION,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: NODE_ENV,
  });

  // Configure OTLP exporter if endpoint is set
  let spanProcessor = null;
  if (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    const exporter = new OTLPTraceExporter({
      url: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    });
    spanProcessor = new BatchSpanProcessor(exporter);
    console.log(`[Telemetry] OTLP trace exporter configured: ${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}`);
  } else {
    console.log('[Telemetry] No OTLP endpoint configured, traces will not be exported');
  }

  sdk = new NodeSDK({
    resource,
    spanProcessor,
    instrumentations: [
      new HttpInstrumentation({
        requestHook: (span, request) => {
          span.setAttribute('http.request.header.x-forwarded-for', request.headers?.['x-forwarded-for'] || '');
        },
        responseHook: (span, response) => {
          span.setAttribute('http.response.header.x-request-id', response.getHeader?.('x-request-id') || '');
        },
      }),
      new ExpressInstrumentation({
        requestHook: (span, request) => {
          span.setAttribute('http.route', request.route?.path || request.path);
        },
      }),
      new PgInstrumentation({
        requireParentSpan: true,
        enhancedDatabaseReporting: true,
      }),
      new RedisInstrumentation({
        requireParentSpan: true,
      }),
      new SocketIoInstrumentation(),
    ],
  });

  sdk.start();
  initialized = true;
  console.log(`[Telemetry] Initialized for ${SERVICE_NAME} v${SERVICE_VERSION} (${NODE_ENV})`);
  return trace.getTracerProvider();
}

function getTracer(name) {
  if (!initialized) initTelemetry();
  return trace.getTracer(name, SERVICE_VERSION);
}

function shutdownTelemetry() {
  if (sdk) {
    return sdk.shutdown().then(() => {
      console.log('[Telemetry] Shutdown complete');
    });
  }
  return Promise.resolve();
}

module.exports = {
  initTelemetry,
  getTracer,
  shutdownTelemetry,
};