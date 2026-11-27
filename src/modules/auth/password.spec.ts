import { describe, expect, it } from 'vitest';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    await expect(
      verifyPassword('correct horse battery staple', hash),
    ).resolves.toBe(true);
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('uses a fresh salt for every hash', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    expect(first).not.toBe(second);
    await expect(verifyPassword('same password', first)).resolves.toBe(true);
    await expect(verifyPassword('same password', second)).resolves.toBe(true);
  });

  it('supports unicode passwords', async () => {
    const hash = await hashPassword('哆啦A梦-密码-🔐');
    await expect(verifyPassword('哆啦A梦-密码-🔐', hash)).resolves.toBe(true);
    await expect(verifyPassword('哆啦A梦-密码', hash)).resolves.toBe(false);
  });

  it('returns false for malformed or unsupported hashes', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$1$2$3$bad$bad')).resolves.toBe(
      false,
    );
    await expect(verifyPassword('x', 'bcrypt$16384$8$1$bad$bad')).resolves.toBe(
      false,
    );
  });

  it('provides a stable dummy hash for unknown accounts', async () => {
    const first = getDummyHash();
    const second = getDummyHash();

    expect(first).toBe(second);
    await expect(verifyPassword('x', await first)).resolves.toBe(false);
  });
});
