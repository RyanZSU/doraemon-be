import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt, so the backend needs no native
 * dependency (bcrypt/argon2) on Azure App Service.
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>`.
 * The parameters are embedded so a future upgrade can verify old hashes and
 * re-hash on the next successful login.
 */
const ALGORITHM = 'scrypt';
const COST_N = 16_384;
const BLOCK_SIZE_R = 8;
const PARALLELIZATION_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

interface ParsedHash {
  salt: Buffer;
  hash: Buffer;
}

function deriveKey(
  plain: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      keyLength,
      {
        N: COST_N,
        r: BLOCK_SIZE_R,
        p: PARALLELIZATION_P,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(key);
      },
    );
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(plain, salt, KEY_LENGTH);
  return [
    ALGORITHM,
    COST_N,
    BLOCK_SIZE_R,
    PARALLELIZATION_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    return false;
  }

  try {
    const hash = await deriveKey(plain, parsed.salt, parsed.hash.length);
    return (
      hash.length === parsed.hash.length && timingSafeEqual(hash, parsed.hash)
    );
  } catch {
    return false;
  }
}

/**
 * A lazily-created hash used when the phone number does not exist. Verifying
 * against it keeps the failure path as expensive as a real password check,
 * which makes account enumeration by timing harder.
 */
let dummyHashPromise: Promise<string> | null = null;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) {
    return null;
  }

  const [algorithm, cost, blockSize, parallelization, saltB64, hashB64] = parts;
  if (
    algorithm !== ALGORITHM ||
    Number(cost) !== COST_N ||
    Number(blockSize) !== BLOCK_SIZE_R ||
    Number(parallelization) !== PARALLELIZATION_P
  ) {
    return null;
  }

  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) {
    return null;
  }

  return { salt, hash };
}
