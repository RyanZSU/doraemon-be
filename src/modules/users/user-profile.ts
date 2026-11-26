import type { UserDocument } from './schemas/user.schema.js';

export interface UserProfile {
  id: string;
  phone: string;
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
    phone: user.phone,
    nickname: user.nickname ?? null,
    avatarUrl: user.avatarUrl ?? null,
    wechatId: user.wechatId ?? null,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}