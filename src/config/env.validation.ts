import Joi from 'joi';

/**
 * Validates and coerces environment variables at startup. Fails fast with a
 * readable message instead of crashing later on an undefined config value.
 */
const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  MONGODB_URI: Joi.string()
    .pattern(/^mongodb(\+srv)?:\/\//)
    .required(),
  MONGO_DB_NAME: Joi.string().default('doraemon'),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN_SECONDS: Joi.number().integer().min(60).default(604800),

  WECHAT_APP_ID: Joi.string().required(),
  WECHAT_APP_SECRET: Joi.string().required(),
  WECHAT_API_TIMEOUT_MS: Joi.number().integer().min(500).default(5000),

  // Off by default in production; set SWAGGER_ENABLED=true in development.
  SWAGGER_ENABLED: Joi.boolean().default(false),
}).unknown(true);

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { error, value } = envSchema.validate(config, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    throw new Error(`Environment validation failed: ${error.message}`);
  }

  return value as Record<string, unknown>;
}