import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { User, type UserDocument } from './schemas/user.schema.js';

/**
 * Reconciles the users collection indexes on startup.
 *
 * Earlier versions declared `phone` as a required, non-sparse unique index.
 * Since phone is now optional for openid-only accounts, that legacy index
 * would reject a second account without a phone. syncIndexes() drops stale
 * indexes and creates the sparse one declared on the schema.
 */
@Injectable()
export class UserIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserIndexService.name);

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.userModel.syncIndexes();
    } catch (error) {
      this.logger.error(
        '同步 users 索引失败，旧的非 sparse phone 索引可能需要手动删除',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
