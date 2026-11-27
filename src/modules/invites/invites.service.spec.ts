import { BadRequestException } from '@nestjs/common';
import type { Model, Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateInviteCode, INVITE_CODE_LENGTH } from './invite-code.js';
import { InvitesService } from './invites.service.js';
import type { InviteDocument } from './schemas/invite.schema.js';

describe('InvitesService', () => {
  let service: InvitesService;
  let inviteModel: {
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    updateOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    inviteModel = {
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      create: vi.fn(),
    };
    service = new InvitesService(
      inviteModel as unknown as Model<InviteDocument>,
    );
  });

  it('consumes an unused, unexpired code atomically', async () => {
    const invite = { _id: { toString: () => 'invite-1' } };
    inviteModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockResolvedValue(invite),
    });

    const result = await service.consume(' abcd2345 ');

    expect(result).toBe(invite);
    const [filter, update, options] =
      inviteModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ code: 'ABCD2345', usedAt: null });
    expect(filter.$or).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: expect.any(Date) } },
    ]);
    expect(update).toEqual({ $set: { usedAt: expect.any(Date) } });
    expect(options).toEqual({ new: true });
  });

  it('rejects an unknown, used or expired code', async () => {
    inviteModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });

    await expect(service.consume('NOPE2345')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('releases a claimed invite', async () => {
    inviteModel.updateOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    });
    const inviteId = {
      toString: () => 'invite-1',
    } as unknown as Types.ObjectId;

    await service.release(inviteId);

    expect(inviteModel.updateOne).toHaveBeenCalledWith(
      { _id: inviteId },
      { $set: { usedAt: null } },
    );
  });

  it('records which user consumed an invite', async () => {
    inviteModel.updateOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    });
    const inviteId = {
      toString: () => 'invite-1',
    } as unknown as Types.ObjectId;
    const userId = { toString: () => 'user-1' } as unknown as Types.ObjectId;

    await service.markUsedBy(inviteId, userId);

    expect(inviteModel.updateOne).toHaveBeenCalledWith(
      { _id: inviteId },
      { $set: { usedBy: userId } },
    );
  });

  it('creates invites with a default 30-day expiry', async () => {
    inviteModel.create.mockImplementation(async (doc: unknown) => doc);

    const created = await service.createMany({
      count: 2,
      note: '亲戚',
    });

    expect(created).toHaveLength(2);
    const expiresAt = (created[0] as { expiresAt: Date }).expiresAt;
    const remainingDays = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(remainingDays).toBeGreaterThan(29.9);
    expect(remainingDays).toBeLessThanOrEqual(30);
  });

  it('generates readable codes without ambiguous characters', () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    }
  });
});
