import path from 'node:path';

/**
 * Runtime configuration. BokyDo needs no configuration to run: every value has a default that
 * matches the shipped compose stack. Environment variables exist only as optional overrides for
 * development and non-compose deployments. Anything a user would want to change lives in
 * Admin → Settings, not here.
 */
export interface Config {
  dataDir: string;
  secretsDir: string;
  host: string;
  port: number;
  logLevel: string;
  webRoot: string | null;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    /** Set only for an externally managed database; otherwise the app generates the password. */
    passwordFile: string | null;
    /** Volume shared with the Postgres container, holding nothing but its password. */
    sharedSecretDir: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.BOKYDO_DATA_DIR ?? '/data');
  const secretsDir = path.join(dataDir, 'secrets');
  return {
    dataDir,
    secretsDir,
    host: env.BOKYDO_HOST ?? '0.0.0.0',
    port: parsePort(env.BOKYDO_PORT ?? '8080'),
    logLevel: env.BOKYDO_LOG_LEVEL ?? 'info',
    webRoot: env.BOKYDO_WEB_ROOT === '' ? null : path.resolve(env.BOKYDO_WEB_ROOT ?? '/app/public'),
    db: {
      host: env.BOKYDO_DB_HOST ?? 'db',
      port: parsePort(env.BOKYDO_DB_PORT ?? '5432'),
      database: env.BOKYDO_DB_NAME ?? 'bokydo',
      user: env.BOKYDO_DB_USER ?? 'bokydo',
      passwordFile: env.BOKYDO_DB_PASSWORD_FILE ? path.resolve(env.BOKYDO_DB_PASSWORD_FILE) : null,
      sharedSecretDir: path.resolve(env.BOKYDO_DB_SECRET_DIR ?? '/run/bokydo-db'),
    },
  };
}

/** Where the database password lives: an override, or the copy the app generated. */
export function dbPasswordFile(config: Config): string {
  return config.db.passwordFile ?? path.join(config.secretsDir, 'db_password');
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}
