import type { UserDocument } from './schemas/user.schema.js';

export interface UserProfile {
  id: string;
  /** null for openid-only (silent login) accounts. */
  phone: string | null;
  /** null only for legacy accounts created before openid was stored. */
  openid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  wechatId: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toUserProfile(user: UserDocument): UserProfile {
  return {
    id: user._id.toString(),
    phone: user.phone ?? null,
    openid: user.openid ?? null,
    nickname: user.nickname ?? null,
    avatarUrl: user.avatarUrl ?? null,
    wechatId: user.wechatId ?? null,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}
