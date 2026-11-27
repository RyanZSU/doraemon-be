import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Silent login payload for mini programs registered under a personal subject.
 * WeChat does not expose getPhoneNumber to personal accounts, so the openid
 * from wx.login() is the only identity we can rely on.
 */
export class WechatLoginDto {
  @ApiProperty({
    description: 'wx.login() 返回的临时登录凭证 code',
    example: '0a3...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;

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

  @ApiPropertyOptional({ description: '用户自填的微信号', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechatId?: string;
}
