import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteDocument } from '../invites/schemas/invite.schema.js';
import type { InvitesService } from '../invites/invites.service.js';
import type { UserDocument, UserStatus } from '../users/schemas/user.schema.js';
import { AuthService } from './auth.service.js';
import type { LoginDto } from './dto/login.dto.js';
import { LoginAttemptService } from './login-attempt.service.js';
import { hashPassword } from './password.js';
import type { WechatService } from './wechat.service.js';

interface UserDocStub {
  _id: { toString(): string };
  phone?: string;
  passwordHash?: string;
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

function createInviteStub(): InviteDocument {
  return {
    _id: { toString: () => 'invite-1' },
  } as unknown as InviteDocument;
}

function stubFindOne(user: UserDocument | null) {
  return {
    select: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(user),
    }),
  };
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
  let attempts: LoginAttemptService;
  let userModel: {
    updateMany: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let wechat: {
    code2Session: ReturnType<typeof vi.fn>;
    getPhoneNumber: ReturnType<typeof vi.fn>;
  };
  let invites: {
    consume: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    markUsedBy: ReturnType<typeof vi.fn>;
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
      updateMany: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue({}) }),
      findOne: vi.fn(),
      create: vi.fn(),
    };

    invites = {
      consume: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
      markUsedBy: vi.fn().mockResolvedValue(undefined),
    };

    attempts = new LoginAttemptService();
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
      invites as unknown as InvitesService,
      attempts,
    );
  });

  it('creates a user keyed by the server-side verified phone number', async () => {
    const created = createUserDoc({ openid: 'openid-1' });
    userModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });
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
    userModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });
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

  it('registers a phone + password account with a valid invite', async () => {
    const invite = createInviteStub();
    const created = createUserDoc({ nickname: '亲戚' });
    invites.consume.mockResolvedValue(invite);
    userModel.findOne.mockReturnValue(stubFindOne(null));
    userModel.create.mockResolvedValue(created);

    const result = await service.register(
      {
        inviteCode: 'abcd2345',
        phone: '13800138000',
        password: 'secret123',
        nickname: '亲戚',
      },
      '203.0.113.5',
    );

    expect(invites.consume).toHaveBeenCalledWith('abcd2345');
    expect(userModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '13800138000',
        nickname: '亲戚',
        passwordHash: expect.stringMatching(/^scrypt\$/),
        lastLoginAt: expect.any(Date),
      }),
    );
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(invites.markUsedBy).toHaveBeenCalledWith(invite._id, created._id);
    expect(result.isNewUser).toBe(true);

    const payload = await jwt.verifyAsync<{ sub: string; phone: string }>(
      result.accessToken,
    );
    expect(payload).toMatchObject({ sub: 'user-1', phone: '13800138000' });
  });

  it('claims an existing passwordless phone account instead of rejecting it', async () => {
    const invite = createInviteStub();
    const existing = createUserDoc({ openid: 'openid-1' });
    invites.consume.mockResolvedValue(invite);
    userModel.findOne.mockReturnValue(stubFindOne(existing));

    const result = await service.register(
      {
        inviteCode: 'abcd2345',
        phone: '13800138000',
        password: 'secret123',
        nickname: '亲戚',
      },
      '203.0.113.5',
    );

    expect(result.isNewUser).toBe(false);
    expect(existing.passwordHash).toMatch(/^scrypt\$/);
    expect(existing.openid).toBe('openid-1');
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(existing.save).toHaveBeenCalledOnce();
    expect(userModel.create).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(invites.markUsedBy).toHaveBeenCalledWith(invite._id, existing._id);
  });

  it('rejects a duplicate phone and releases the invite', async () => {
    const invite = createInviteStub();
    invites.consume.mockResolvedValue(invite);
    userModel.findOne.mockReturnValue(stubFindOne(null));
    userModel.create.mockRejectedValue({ code: 11000 });

    await expect(
      service.register(
        {
          inviteCode: 'abcd2345',
          phone: '13800138000',
          password: 'secret123',
        },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '该手机号已注册' });

    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(invites.release).toHaveBeenCalledWith(invite._id);
  });

  it('rejects an account that already has a password and releases the invite', async () => {
    const invite = createInviteStub();
    const existing = createUserDoc({ passwordHash: 'scrypt$existing' });
    invites.consume.mockResolvedValue(invite);
    userModel.findOne.mockReturnValue(stubFindOne(existing));

    await expect(
      service.register(
        {
          inviteCode: 'abcd2345',
          phone: '13800138000',
          password: 'secret123',
        },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '该手机号已注册' });

    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(invites.release).toHaveBeenCalledWith(invite._id);
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('does not consume a user when the invite is invalid', async () => {
    invites.consume.mockRejectedValue(
      new BadRequestException('邀请码无效或已被使用'),
    );

    await expect(
      service.register(
        {
          inviteCode: 'NOPE',
          phone: '13800138000',
          password: 'secret123',
        },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '邀请码无效或已被使用' });

    expect(userModel.create).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(invites.release).not.toHaveBeenCalled();
  });

  it('logs in with the correct password and updates lastLoginAt', async () => {
    const passwordHash = await hashPassword('secret123');
    const user = createUserDoc({ passwordHash });
    userModel.findOne.mockReturnValue(stubFindOne(user));

    const result = await service.passwordLogin(
      { phone: '13800138000', password: 'secret123' },
      '203.0.113.5',
    );

    expect(result.isNewUser).toBe(false);
    expect(user.lastLoginAt).toBeInstanceOf(Date);
    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(user.save).toHaveBeenCalledOnce();
  });

  it('rejects a wrong password without revealing whether the phone exists', async () => {
    const passwordHash = await hashPassword('secret123');
    const user = createUserDoc({ passwordHash });
    userModel.findOne.mockReturnValue(stubFindOne(user));

    await expect(
      service.passwordLogin(
        { phone: '13800138000', password: 'wrongpass' },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '手机号或密码错误' });

    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(user.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown phone number with the same generic error', async () => {
    userModel.findOne.mockReturnValue(stubFindOne(null));

    await expect(
      service.passwordLogin(
        { phone: '13900139000', password: 'secret123' },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '手机号或密码错误' });
  });

  it('rejects a disabled account after verifying the password', async () => {
    const passwordHash = await hashPassword('secret123');
    const user = createUserDoc({ passwordHash, status: 'disabled' });
    userModel.findOne.mockReturnValue(stubFindOne(user));

    await expect(
      service.passwordLogin(
        { phone: '13800138000', password: 'secret123' },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '账号已被禁用' });

    // oxlint-disable-next-line typescript/unbound-method -- Vitest mock, no `this`
    expect(user.save).not.toHaveBeenCalled();
  });

  it('rate-limits password attempts before hitting the database', async () => {
    const phoneKey = 'login:phone:13800138000';
    for (let i = 0; i < 5; i += 1) {
      attempts.hit(phoneKey, 5, 15 * 60 * 1000);
    }

    await expect(
      service.passwordLogin(
        { phone: '13800138000', password: 'secret123' },
        '203.0.113.5',
      ),
    ).rejects.toMatchObject({ message: '尝试次数过多，请稍后再试' });

    expect(userModel.findOne).not.toHaveBeenCalled();
  });
});
