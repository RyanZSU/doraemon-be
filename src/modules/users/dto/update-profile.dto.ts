import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: '昵称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 URL', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  avatarUrl?: string;

  @ApiPropertyOptional({
    description: '用户自填的微信号（微信接口不提供该字段）',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechatId?: string;
}