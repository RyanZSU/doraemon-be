import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import { User, type UserDocument } from './schemas/user.schema.js';
import { toUserProfile, type UserProfile } from './user-profile.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return toUserProfile(user);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );

    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $set: changes },
        { new: true, runValidators: true },
      )
      .exec();

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return toUserProfile(user);
  }
}