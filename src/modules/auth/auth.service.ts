import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { LoginDto } from './dto/login.dto.js';
import { User, type UserDocument } from '../users/schemas/user.schema.js';
import { toUserProfile } from '../users/user-profile.js';
import type { LoginResult } from './auth.types.js';
import type { WechatSession } from './wechat.types.js';
import { WechatService } from './wechat.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly wechat: WechatService,
    private readonly jwt: JwtService,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Login flow:
   * 1. Exchange wx.login code -> openid (server side only).
   * 2. Exchange getPhoneNumber code -> verified phone number (server side only).
   * 3. Find or create the user keyed by phone, bind the openid, then issue a JWT.
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

    const payload = { sub: user._id.toString(), phone: user.phone };
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

    const changes: Partial<User> = {
      openid: session.openid,
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
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}