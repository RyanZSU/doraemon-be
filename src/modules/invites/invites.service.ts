import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { buildInvite, DEFAULT_INVITE_DAYS } from './invite-code.js';
import { Invite, type InviteDocument } from './schemas/invite.schema.js';

export interface CreateInvitesOptions {
  count: number;
  note?: string;
  days?: number;
}

@Injectable()
export class InvitesService {
  constructor(
    @InjectModel(Invite.name)
    private readonly inviteModel: Model<InviteDocument>,
  ) {}

  /**
   * Atomically claims an invite. The filter matches only unused, unexpired
   * codes, so two concurrent registrations cannot both consume the same one.
   */
  async consume(code: string): Promise<InviteDocument> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();

    const invite = await this.inviteModel
      .findOneAndUpdate(
        {
          code: normalized,
          usedAt: null,
          $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
        },
        { $set: { usedAt: now } },
        { new: true },
      )
      .exec();

    if (!invite) {
      throw new BadRequestException('邀请码无效或已被使用');
    }

    return invite;
  }

  /** Rolls a claimed invite back when registration fails. */
  async release(inviteId: Types.ObjectId): Promise<void> {
    await this.inviteModel
      .updateOne({ _id: inviteId }, { $set: { usedAt: null } })
      .exec();
  }

  async markUsedBy(
    inviteId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<void> {
    await this.inviteModel
      .updateOne({ _id: inviteId }, { $set: { usedBy: userId } })
      .exec();
  }

  /** Used by the CLI script; the HTTP API never issues invites. */
  async createMany(options: CreateInvitesOptions): Promise<InviteDocument[]> {
    const days = options.days ?? DEFAULT_INVITE_DAYS;

    const created: InviteDocument[] = [];
    for (let i = 0; i < options.count; i += 1) {
      created.push(
        await this.inviteModel.create(buildInvite(options.note, days)),
      );
    }
    return created;
  }
}
