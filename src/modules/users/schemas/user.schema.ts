import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Accounts can be created in two ways:
 * - Phone login: the server-verified phone number is the account key. This
 *   requires an organisation subject with getPhoneNumber permission.
 * - Silent login: only the WeChat openid is available (personal subjects).
 *
 * Phone is therefore optional. Both keys are unique + sparse so multiple
 * openid-only accounts do not collide on a missing phone value.
 */
@Schema({ timestamps: true, collection: 'users', versionKey: false })
export class User {
  @Prop({ trim: true })
  phone?: string;

  @Prop({ unique: true, sparse: true, trim: true })
  openid?: string;

  @Prop({ sparse: true, trim: true })
  unionid?: string;

  @Prop({ trim: true, maxlength: 64 })
  nickname?: string;

  @Prop({ maxlength: 1024 })
  avatarUrl?: string;

  /** Self-reported WeChat ID. WeChat APIs do not expose the user's 微信号. */
  @Prop({ trim: true, maxlength: 64 })
  wechatId?: string;

  @Prop({ type: String, enum: USER_STATUSES, default: 'active' })
  status!: UserStatus;

  @Prop()
  lastLoginAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type UserDocument = HydratedDocument<User>;

export const UserSchema = SchemaFactory.createForClass(User);

/**
 * An explicit index name avoids IndexOptionsConflict with the legacy
 * non-sparse `phone_1` index created by earlier deployments. UserIndexService
 * calls syncIndexes() on startup to drop stale indexes.
 */
UserSchema.index(
  { phone: 1 },
  { unique: true, sparse: true, name: 'phone_sparse_unique' },
);
