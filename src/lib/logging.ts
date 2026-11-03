/**
 * Single source of the frontend's structured logger. OTel export is off
 * until OTEL_ENABLED/OTEL_EXPORTER_OTLP_ENDPOINT are set.
 */
import { configureOtel, createLogger } from '@i-dot-ai-npm/utilities-observability';

const serviceName = process.env.OTEL_SERVICE_NAME || 'core-llm-gateway-frontend';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otelEnabled = process.env.OTEL_ENABLED === 'true';
const deploymentEnvironment = process.env.ENVIRONMENT;

if (otelEnabled && otlpEndpoint) {
  try {
    // configureOtel patches Pino, so it must run before createLogger.
    await configureOtel({ serviceName, deploymentEnvironment, otlpEndpoint });
  } catch (error) {
    console.warn('OTel setup failed; continuing with local structured logging only', error);
  }
}

export const logger = createLogger({
  serviceName,
  deploymentEnvironment,
  otlpEndpoint,
  shipLogs: otelEnabled ? 1 : 0,
});
