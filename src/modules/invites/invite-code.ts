import { randomInt } from 'node:crypto';

/** Ambiguous characters (I/O/0/1) are excluded so codes are easy to read out. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;
export const DEFAULT_INVITE_DAYS = 30;

export interface NewInvite {
  code: string;
  note?: string;
  expiresAt: Date;
}

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Shared by the service and the local CLI script. */
export function buildInvite(
  note?: string,
  days = DEFAULT_INVITE_DAYS,
): NewInvite {
  return {
    code: generateInviteCode(),
    note,
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  };
}
