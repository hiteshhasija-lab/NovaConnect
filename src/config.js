'use strict';

const { z } = require('zod');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HTTPS_PORT: z.coerce.number().int().positive().default(3443),
  HOST: z.string().default('0.0.0.0'),

  // Database (required in production, optional in dev with defaults)
  PGHOST: IS_PRODUCTION ? z.string().min(1) : z.string().default('localhost'),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: IS_PRODUCTION ? z.string().min(1) : z.string().default('novadesk'),
  PGPASSWORD: IS_PRODUCTION ? z.string().min(1) : z.string().default('novadesk_dev_pw'),
  PGDATABASE: IS_PRODUCTION ? z.string().min(1) : z.string().default('novaconnect'),

  // Session (required in production, dev default)
  SESSION_SECRET: IS_PRODUCTION
    ? z.string().min(32, 'SESSION_SECRET must be at least 32 characters')
    : z.string().default('novaconnect-dev-secret-change-me'),

  // Redis (required for scaling)
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),

  // Gemini AI (optional but recommended)
  GEMINI_API_KEY: z.string().optional(),

  // OpenTelemetry (optional)
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional().or(z.literal('')),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default(IS_PRODUCTION ? 'info' : 'debug'),

  // File storage (optional)
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_CDN_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  LOCAL_UPLOAD_ROOT: z.string().optional(),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // TLS (optional for production)
  TLS_KEY_PATH: z.string().optional(),
  TLS_CERT_PATH: z.string().optional(),

  // WebRTC/ICE (optional)
  WEBRTC_ICE_SERVERS: z.string().optional(),
}).passthrough();

let validatedConfig = null;

function validateConfig() {
  if (validatedConfig) return validatedConfig;

  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');
    const msg = `Configuration validation failed:\n${errors}`;
    console.error(msg);
    throw new Error(msg);
  }

  validatedConfig = result.data;

  // Additional production checks
  if (IS_PRODUCTION) {
    const warnings = [];
    if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
      warnings.push('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT not set — traces will not be exported');
    }
    if (process.env.SESSION_SECRET === 'novaconnect-dev-secret-change-me') {
      warnings.push('SESSION_SECRET uses default dev value — must be changed in production');
    }
    if (process.env.STORAGE_DRIVER === 'local') {
      warnings.push('STORAGE_DRIVER=local in production — consider S3 for durability');
    }
    if (warnings.length) {
      console.warn('[Config] Production warnings:\n' + warnings.map(w => `  - ${w}`).join('\n'));
    }
  }

  console.log(`[Config] Validated (${NODE_ENV})`);
  return validatedConfig;
}

function getConfig() {
  if (!validatedConfig) validateConfig();
  return validatedConfig;
}

function requireConfig() {
  const config = getConfig();
  if (!config) throw new Error('Config not validated');
  return config;
}

module.exports = {
  validateConfig,
  getConfig,
  requireConfig,
  EnvSchema,
  NODE_ENV,
  IS_PRODUCTION,
};