import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type { InviteDocument } from '../invites/schemas/invite.schema.js';
import { InvitesService } from '../invites/invites.service.js';
import { User, type UserDocument } from '../users/schemas/user.schema.js';
import { toUserProfile } from '../users/user-profile.js';
import type { LoginResult } from './auth.types.js';
import type { LoginDto } from './dto/login.dto.js';
import type { PasswordLoginDto } from './dto/password-login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { WechatLoginDto } from './dto/wechat-login.dto.js';
import { LoginAttemptService } from './login-attempt.service.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import type { WechatSession } from './wechat.types.js';
import { WechatService } from './wechat.service.js';

type ProfileFields = Pick<
  WechatLoginDto,
  'nickname' | 'avatarUrl' | 'wechatId'
>;

const LOGIN_ATTEMPTS_PER_PHONE = 5;
const LOGIN_ATTEMPTS_PER_IP = 30;
const REGISTER_ATTEMPTS_PER_IP = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly wechat: WechatService,
    private readonly jwt: JwtService,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
    private readonly invites: InvitesService,
    private readonly attempts: LoginAttemptService,
  ) {}

  /**
   * Silent login (default for personal mini programs):
   * wx.login code -> openid -> find-or-create by openid -> JWT.
   * No phone number is available or required.
   */
  async wechatLogin(dto: WechatLoginDto): Promise<LoginResult> {
    const session = await this.wechat.code2Session(dto.code);
    const { user, isNewUser } = await this.upsertByOpenid(session, dto);
    return this.issueToken(user, isNewUser);
  }

  /**
   * Phone login (organisation subjects only):
   * 1. Exchange wx.login code -> openid (server side only).
   * 2. Exchange getPhoneNumber code -> verified phone (server side only).
   * 3. Find or create keyed by phone, bind the openid, then issue a JWT.
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const [session, phone] = await Promise.all([
      this.wechat.code2Session(dto.code),
      this.wechat.getPhoneNumber(dto.phoneCode),
    ]);

    const { user, isNewUser } = await this.upsertByPhone(
      phone.purePhoneNumber,
      session,
      dto,
    );

    return this.issueToken(user, isNewUser);
  }

  /**
   * Invite-gated registration for phone + password accounts. This is the
   * client-agnostic account path shared by the Android app, iOS and a future
   * published mini program.
   *
   * The phone here is a self-asserted account identifier, not a WeChat-verified
   * number: there is no SMS verification, and holding a valid invite is the
   * trust gate. WeChat phone login (`login`) still only accepts server-verified
   * numbers.
   */
  async register(dto: RegisterDto, ip: string): Promise<LoginResult> {
    this.attempts.hit(
      `register:ip:${ip}`,
      REGISTER_ATTEMPTS_PER_IP,
      REGISTER_WINDOW_MS,
    );

    const invite = await this.invites.consume(dto.inviteCode);
    try {
      return await this.claimOrCreateAccount(dto, invite);
    } catch (error) {
      await this.invites.release(invite._id);
      throw error;
    }
  }

  async passwordLogin(dto: PasswordLoginDto, ip: string): Promise<LoginResult> {
    const phoneKey = `login:phone:${dto.phone}`;
    const ipKey = `login:ip:${ip}`;
    this.attempts.hit(phoneKey, LOGIN_ATTEMPTS_PER_PHONE, LOGIN_WINDOW_MS);
    this.attempts.hit(ipKey, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS);

    const user = await this.userModel
      .findOne({ phone: dto.phone })
      .select('+passwordHash')
      .exec();

    // Burn the same scrypt work even when the account does not exist, so the
    // failure timing does not reveal which phone numbers are registered.
    const storedHash = user?.passwordHash ?? (await getDummyHash());
    const passwordMatches = await verifyPassword(dto.password, storedHash);

    if (!user || !user.passwordHash || !passwordMatches) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    if (user.status !== 'active') {
      throw new ForbiddenException('账号已被禁用');
    }

    this.attempts.clear(phoneKey);
    this.attempts.clear(ipKey);
    user.lastLoginAt = new Date();
    await user.save();

    return this.issueToken(user, false);
  }

  /**
   * Claims an existing passwordless phone account (for example one created by
   * the organisation-subject WeChat phone login) instead of rejecting it, so
   * the account stays reachable from the app. Accounts that already have a
   * password conflict.
   */
  private async claimOrCreateAccount(
    dto: RegisterDto,
    invite: InviteDocument,
  ): Promise<LoginResult> {
    const passwordHash = await hashPassword(dto.password);
    const existing = await this.userModel
      .findOne({ phone: dto.phone })
      .select('+passwordHash')
      .exec();

    if (existing) {
      if (existing.passwordHash) {
        throw new ConflictException('该手机号已注册');
      }
      if (existing.status !== 'active') {
        throw new ForbiddenException('账号已被禁用');
      }

      existing.passwordHash = passwordHash;
      if (!existing.nickname && dto.nickname !== undefined) {
        existing.nickname = dto.nickname;
      }
      existing.lastLoginAt = new Date();
      await existing.save();
      await this.recordInviteUsage(invite, existing._id);

      return this.issueToken(existing, false);
    }

    let created: UserDocument;
    try {
      created = await this.userModel.create({
        phone: dto.phone,
        passwordHash,
        ...(dto.nickname === undefined ? {} : { nickname: dto.nickname }),
        lastLoginAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // Lost a race with another registration for the same phone.
        throw new ConflictException('该手机号已注册');
      }
      throw error;
    }

    await this.recordInviteUsage(invite, created._id);
    return this.issueToken(created, true);
  }

  /** Invite usage metadata is useful but must not fail a registration. */
  private async recordInviteUsage(
    invite: InviteDocument,
    userId: Types.ObjectId,
  ): Promise<void> {
    try {
      await this.invites.markUsedBy(invite._id, userId);
    } catch (error) {
      this.logger.warn(`Failed to record invite usage: ${String(error)}`);
    }
  }

  private async issueToken(
    user: UserDocument,
    isNewUser: boolean,
  ): Promise<LoginResult> {
    const payload = {
      sub: user._id.toString(),
      phone: user.phone ?? null,
      openid: user.openid ?? null,
    };
    const accessToken = await this.jwt.signAsync(payload);
    const expiresIn = this.config.getOrThrow<number>('JWT_EXPIRES_IN_SECONDS');

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      isNewUser,
      user: toUserProfile(user),
    };
  }

  private async upsertByOpenid(
    session: WechatSession,
    dto: ProfileFields,
  ): Promise<{ user: UserDocument; isNewUser: boolean }> {
    const changes = this.buildChanges(dto, session, {});

    let user = await this.userModel.findOne({ openid: session.openid }).exec();
    if (!user) {
      try {
        const created = await this.userModel.create({
          openid: session.openid,
          ...changes,
        });
        return { user: created, isNewUser: true };
      } catch (error) {
        // Two concurrent first logins for the same openid: use the winner.
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        user = await this.userModel.findOne({ openid: session.openid }).exec();
        if (!user) {
          throw error;
        }
      }
    }

    user.set(changes);
    await user.save();
    return { user, isNewUser: false };
  }

  private async upsertByPhone(
    phone: string,
    session: WechatSession,
    dto: LoginDto,
  ): Promise<{ user: UserDocument; isNewUser: boolean }> {
    // The openid may only be bound to one account. If the same WeChat user
    // logs in with a different phone, move the binding to the new account.
    await this.userModel
      .updateMany(
        { openid: session.openid, phone: { $ne: phone } },
        { $unset: { openid: '' } },
      )
      .exec();

    const changes = this.buildChanges(dto, session, {
      openid: session.openid,
    });

    let user = await this.userModel.findOne({ phone }).exec();
    if (!user) {
      try {
        const created = await this.userModel.create({ phone, ...changes });
        return { user: created, isNewUser: true };
      } catch (error) {
        // Two concurrent logins for a new phone: fall back to the winner.
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        user = await this.userModel.findOne({ phone }).exec();
        if (!user) {
          throw error;
        }
      }
    }

    user.set(changes);
    await user.save();
    return { user, isNewUser: false };
  }

  private buildChanges(
    dto: ProfileFields,
    session: WechatSession,
    extra: Partial<User>,
  ): Partial<User> {
    const changes: Partial<User> = {
      ...extra,
      lastLoginAt: new Date(),
    };
    if (session.unionid) {
      changes.unionid = session.unionid;
    }
    if (dto.nickname !== undefined) {
      changes.nickname = dto.nickname;
    }
    if (dto.avatarUrl !== undefined) {
      changes.avatarUrl = dto.avatarUrl;
    }
    if (dto.wechatId !== undefined) {
      changes.wechatId = dto.wechatId;
    }
    return changes;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}
