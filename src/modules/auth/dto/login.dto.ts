import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'wx.login() 返回的临时登录凭证 code',
    example: '0a3...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;

  @ApiProperty({
    description:
      '手机号授权按钮（open-type="getPhoneNumber"）返回的 code；后端用它向微信换取真实手机号',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  phoneCode!: string;

  @ApiPropertyOptional({ description: '昵称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 URL（微信临时链接需尽快转存）', maxLength: 1024 })
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