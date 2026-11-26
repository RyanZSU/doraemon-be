import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * A user is identified by their phone number (retrieved from WeChat on the
 * server, never trusted from the client). The WeChat openid is a credential
 * that can be re-bound when a user changes phone number.
 */
@Schema({ timestamps: true, collection: 'users', versionKey: false })
export class User {
  @Prop({ required: true, unique: true, trim: true })
  phone!: string;

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