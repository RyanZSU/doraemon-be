import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { buildInvite } from '../modules/invites/invite-code.js';
import {
  Invite,
  InviteSchema,
} from '../modules/invites/schemas/invite.schema.js';

const DEFAULT_COUNT = 1;
const DEFAULT_DAYS = 30;
const MAX_COUNT = 50;
const MAX_DAYS = 365;

/**
 * Local admin helper — never called from the HTTP API.
 *
 * Usage (run `npm run build` first):
 *   npm run invite:create -- --count 3 --note "亲戚" --days 30
 *   npm run invite:create -- --count 1 --json
 *
 * The connection string is resolved from --mongo-uri, MONGODB_URI, .env.local,
 * .env, then .secrets/mongo-connection-string.txt. Only a redacted target is
 * printed, so it is hard to send invites to the wrong database by accident.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: String(DEFAULT_COUNT) },
      days: { type: 'string', default: String(DEFAULT_DAYS) },
      note: { type: 'string' },
      json: { type: 'boolean', default: false },
      'mongo-uri': { type: 'string' },
    },
  });

  loadEnvFiles();

  const count = parseInteger(values.count, 'count');
  const days = parseInteger(values.days, 'days');
  if (count < 1 || count > MAX_COUNT) {
    throw new Error(`--count must be between 1 and ${MAX_COUNT}`);
  }
  if (days < 1 || days > MAX_DAYS) {
    throw new Error(`--days must be between 1 and ${MAX_DAYS}`);
  }

  const uri = resolveMongoUri(values['mongo-uri']);
  const dbName = process.env.MONGO_DB_NAME?.trim() || 'doraemon';

  await mongoose.connect(uri, {
    dbName,
    retryWrites: false,
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 5,
  });

  try {
    const InviteModel = mongoose.model(Invite.name, InviteSchema);
    const created = [];
    for (let i = 0; i < count; i += 1) {
      created.push(await InviteModel.create(buildInvite(values.note, days)));
    }

    const payload = created.map((invite) => ({
      code: invite.code,
      note: invite.note ?? null,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
    }));

    // Keep the target visible in both modes so prod/local is never ambiguous.
    const target = describeTarget(uri, dbName);

    if (values.json) {
      console.error(`Target: ${target}`);
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Target: ${target}`);
    console.log(
      `Created ${payload.length} invite code(s), valid until ${payload[0]?.expiresAt ?? '—'}:`,
    );
    for (const invite of payload) {
      console.log(invite.code);
    }
  } finally {
    await mongoose.disconnect();
  }
}

function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) {
      continue;
    }
    try {
      process.loadEnvFile(file);
    } catch {
      // Ignore missing/unreadable env files; the secrets file is the fallback.
    }
  }
}

function resolveMongoUri(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  const secretsFile = resolve('.secrets', 'mongo-connection-string.txt');
  if (existsSync(secretsFile)) {
    const uri = readFileSync(secretsFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (uri) {
      return uri;
    }
  }

  throw new Error(
    'MONGODB_URI is not set and .secrets/mongo-connection-string.txt was not found',
  );
}

function describeTarget(uri: string, dbName: string): string {
  try {
    const parsed = new URL(uri);
    return `${parsed.hostname}${parsed.pathname || ''} (db: ${dbName})`;
  } catch {
    return `(unparseable connection string, db: ${dbName})`;
  }
}

function parseInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${name} must be an integer`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
