import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import type { LoginResult } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { WechatLoginDto } from './dto/wechat-login.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '微信静默登录（openid）',
    description:
      '仅需 wx.login() 的 code；服务端用 jscode2session 换取 openid 并 find-or-create 账号。适用于无法使用手机号能力的个人主体小程序。',
  })
  wechatLogin(@Body() dto: WechatLoginDto): Promise<LoginResult> {
    return this.authService.wechatLogin(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '微信小程序登录（手机号）',
    description:
      '前端同时提供 wx.login 的 code 和手机号授权返回的 phoneCode；手机号由服务端向微信换取，前端无法伪造。需要组织主体并开通获取手机号权限。',
  })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }
}
