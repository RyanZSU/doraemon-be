import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import type { LoginResult } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { PasswordLoginDto } from './dto/password-login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
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

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '邀请码注册（手机号 + 密码）',
    description:
      '客户端无关的账号入口：用一次性邀请码注册手机号 + 密码账号，成功后直接返回 JWT。手机号是自填账号标识，非微信验证号码。',
  })
  register(@Body() dto: RegisterDto, @Ip() ip: string): Promise<LoginResult> {
    return this.authService.register(dto, ip);
  }

  @Public()
  @Post('password-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机号 + 密码登录',
    description:
      '注册后使用手机号和密码登录。Android、iOS 和未来的小程序共用此接口。',
  })
  passwordLogin(
    @Body() dto: PasswordLoginDto,
    @Ip() ip: string,
  ): Promise<LoginResult> {
    return this.authService.passwordLogin(dto, ip);
  }
}
