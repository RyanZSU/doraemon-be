import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

/**
 * One-time invitation code. Anyone holding an unused, unexpired code can
 * register a phone + password account.
 *
 * `usedAt` starts as `null` and is set atomically on consumption; a failed
 * registration releases it back to `null`.
 */
@Schema({ timestamps: true, collection: 'invites', versionKey: false })
export class Invite {
  @Prop({ required: true, unique: true, trim: true, maxlength: 64 })
  code!: string;

  /** Free-form label for the owner (e.g. "给二叔"). */
  @Prop({ trim: true, maxlength: 128 })
  note?: string;

  @Prop()
  expiresAt?: Date;

  @Prop({ type: Date, default: null })
  usedAt?: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  usedBy?: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export type InviteDocument = HydratedDocument<Invite>;

export const InviteSchema = SchemaFactory.createForClass(Invite);
