import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UserDocument,
  UserStatus,
} from '../users/schemas/user.schema.js';
import { AuthService } from './auth.service.js';
import type { LoginDto } from './dto/login.dto.js';
import type { WechatService } from './wechat.service.js';

interface UserDocStub {
  _id: { toString(): string };
  phone?: string;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  openid?: string;
  nickname?: string;
  set: (value: Record<string, unknown>) => void;
  save: ReturnType<typeof vi.fn>;
}

function createUserDoc(overrides: Partial<UserDocStub> = {}): UserDocument {
  const doc: UserDocStub = {
    _id: { toString: () => 'user-1' },
    phone: '13800138000',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
    set(value) {
      Object.assign(this, value);
    },
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return doc as unknown as UserDocument;
}

const loginDto: LoginDto = {
  code: 'wx-login-code',
  phoneCode: 'wx-phone-code',
  nickname: '哆啦A梦',
  avatarUrl: 'https://example.com/avatar.png',
};

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let userModel: {
    updateMany: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let wechat: {
    code2Session: ReturnType<typeof vi.fn>;
    getPhoneNumber: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    wechat = {
      code2Session: vi
        .fn()
        .mockResolvedValue({ openid: 'openid-1', unionid: 'unionid-1' }),
      getPhoneNumber: vi.fn().mockResolvedValue({
        phoneNumber: '+8613800138000',
        purePhoneNumber: '13800138000',
        countryCode: '86',
      }),
    };

    userModel = {
      updateMany: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({}) }),
      findOne: vi.fn(),
      create: vi.fn(),
    };

    jwt = new JwtService({
      secret: 'test-secret-that-is-long-enough-1234567890',
      signOptions: { expiresIn: 3600 },
    });
    const config = new ConfigService({ JWT_EXPIRES_IN_SECONDS: 3600 });

    service = new AuthService(
      wechat as unknown as WechatService,
      jwt,
      userModel as unknown as Model<UserDocument>,
      config,
    );
  });

  it('creates a user keyed by the server-side verified phone number', async () => {
    const created = createUserDoc({ openid: 'openid-1' });
    userModel.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    userModel.create.mockResolvedValue(created);

    const result = await service.login(loginDto);

    expect(result.isNewUser).toBe(true);
    expect(result.user.phone).toBe('13800138000');
    expect(userModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '13800138000',
        openid: 'openid-1',
        unionid: 'unionid-1',
        nickname: '哆啦A梦',
      }),
    );
    // The client-supplied phone is never used: only purePhoneNumber from WeChat.
    const payload = await jwt.verifyAsync<{ sub: string; phone: string }>(
      result.accessToken,
    );
    expect(payload).toMatchObject({ sub: 'user-1', phone: '13800138000' });
  });

  it('updates an existing user and rebinds the openid to the new phone', async () => {
    const existing = createUserDoc();
    userModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(existing),
    });

    const result = await service.login(loginDto);

    expect(result.isNewUser).toBe(false);
    expect(userModel.updateMany).toHaveBeenCalledWith(
      { openid: 'openid-1', phone: { $ne: '13800138000' } },
      { $unset: { openid: '' } },
    );
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(existing.save).toHaveBeenCalledOnce();
    expect(existing.nickname).toBe('哆啦A梦');
  });

  it('reuses the winning user when two logins race to create the same phone', async () => {
    const winner = createUserDoc();
    userModel.findOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(null),
    });
    userModel.findOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(winner),
    });
    userModel.create.mockRejectedValue({ code: 11000 });

    const result = await service.login(loginDto);

    expect(result.isNewUser).toBe(false);
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(winner.save).toHaveBeenCalledOnce();
  });

  it('creates an openid-only account without any phone number', async () => {
    const created = createUserDoc({ phone: undefined, openid: 'openid-1' });
    userModel.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    userModel.create.mockResolvedValue(created);

    const result = await service.wechatLogin({
      code: 'wx-login-code',
      nickname: '百宝箱主人',
    });

    expect(result.isNewUser).toBe(true);
    expect(result.user.phone).toBeNull();
    expect(result.user.openid).toBe('openid-1');
    expect(userModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        openid: 'openid-1',
        unionid: 'unionid-1',
        nickname: '百宝箱主人',
      }),
    );
    expect(wechat.getPhoneNumber).not.toHaveBeenCalled();

    const payload = await jwt.verifyAsync<{
      sub: string;
      phone: null;
      openid: string;
    }>(result.accessToken);
    expect(payload).toMatchObject({
      sub: 'user-1',
      phone: null,
      openid: 'openid-1',
    });
  });

  it('reuses the same openid account on later silent logins', async () => {
    const existing = createUserDoc({ phone: undefined, openid: 'openid-1' });
    userModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(existing),
    });

    const result = await service.wechatLogin({ code: 'wx-login-code' });

    expect(result.isNewUser).toBe(false);
    expect(userModel.findOne).toHaveBeenCalledWith({ openid: 'openid-1' });
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(existing.save).toHaveBeenCalledOnce();
  });

  it('reuses the winner when two silent logins race for the same openid', async () => {
    const winner = createUserDoc({ phone: undefined, openid: 'openid-1' });
    userModel.findOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(null),
    });
    userModel.findOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(winner),
    });
    userModel.create.mockRejectedValue({ code: 11000 });

    const result = await service.wechatLogin({ code: 'wx-login-code' });

    expect(result.isNewUser).toBe(false);
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(winner.save).toHaveBeenCalledOnce();
  });
});
