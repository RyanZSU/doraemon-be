import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import type {
  Jscode2SessionResponse,
  PhoneNumberResponse,
  StableTokenResponse,
  WechatPhone,
  WechatSession,
} from './wechat.types.js';

const WECHAT_API = 'https://api.weixin.qq.com';
/** WeChat codes that mean the cached access token must be refreshed. */
const ACCESS_TOKEN_ERRCODES = new Set([40001, 40014, 42001]);

/**
 * Thin client for the WeChat mini program server APIs.
 *
 * Access tokens are cached in memory per instance and refreshed shortly before
 * expiry. The `stable_token` endpoint is used instead of `token` so concurrent
 * requests from multiple App Service instances do not invalidate each other.
 */
@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private readonly http: AxiosInstance;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      timeout: config.getOrThrow<number>('WECHAT_API_TIMEOUT_MS'),
    });
  }

  /** Exchanges wx.login() code for openid (and unionid when available). */
  async code2Session(code: string): Promise<WechatSession> {
    const data = await this.request<Jscode2SessionResponse>('jscode2session', () =>
      this.http.get<Jscode2SessionResponse>(
        `${WECHAT_API}/sns/jscode2session`,
        {
          params: {
            appid: this.config.getOrThrow<string>('WECHAT_APP_ID'),
            secret: this.config.getOrThrow<string>('WECHAT_APP_SECRET'),
            js_code: code,
            grant_type: 'authorization_code',
          },
        },
      ),
    );

    this.assertNoError('jscode2session', data);
    if (!data.openid) {
      throw new BadGatewayException('微信登录失败：未返回 openid');
    }

    return { openid: data.openid, unionid: data.unionid };
  }

  /** Resolves the verified phone number behind a getPhoneNumber code. */
  async getPhoneNumber(phoneCode: string): Promise<WechatPhone> {
    let token = await this.getAccessToken();
    let data = await this.requestPhone(phoneCode, token);

    if (data.errcode !== undefined && ACCESS_TOKEN_ERRCODES.has(data.errcode)) {
      this.logger.warn(`Access token rejected (${data.errcode}), refreshing`);
      token = await this.getAccessToken(true);
      data = await this.requestPhone(phoneCode, token);
    }

    this.assertNoError('getuserphonenumber', data);
    const info = data.phone_info;
    const phoneNumber = info?.phoneNumber;
    const purePhoneNumber = info?.purePhoneNumber ?? phoneNumber;
    if (!phoneNumber || !purePhoneNumber) {
      throw new BadGatewayException('微信登录失败：未返回手机号');
    }

    return {
      phoneNumber,
      purePhoneNumber,
      countryCode: info?.countryCode ?? '86',
    };
  }

  private requestPhone(
    phoneCode: string,
    accessToken: string,
  ): Promise<PhoneNumberResponse> {
    return this.request<PhoneNumberResponse>('getuserphonenumber', () =>
      this.http.post<PhoneNumberResponse>(
        `${WECHAT_API}/wxa/business/getuserphonenumber`,
        { code: phoneCode },
        { params: { access_token: accessToken } },
      ),
    );
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    // Single-flight: concurrent logins share one token request.
    this.tokenRequest ??= this.requestAccessToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async requestAccessToken(): Promise<string> {
    const data = await this.request<StableTokenResponse>('stable_token', () =>
      this.http.post<StableTokenResponse>(`${WECHAT_API}/cgi-bin/stable_token`, {
        grant_type: 'client_credential',
        appid: this.config.getOrThrow<string>('WECHAT_APP_ID'),
        secret: this.config.getOrThrow<string>('WECHAT_APP_SECRET'),
        force_refresh: false,
      }),
    );

    this.assertNoError('stable_token', data);
    if (!data.access_token || !data.expires_in) {
      throw new BadGatewayException('微信服务异常：未返回 access_token');
    }

    this.tokenCache = {
      accessToken: data.access_token,
      // Refresh 5 minutes before expiry to avoid races.
      expiresAt: Date.now() + Math.max(data.expires_in - 300, 60) * 1000,
    };
    return data.access_token;
  }

  private async request<T>(api: string, send: () => Promise<{ data: T }>): Promise<T> {
    try {
      const response = await send();
      return response.data;
    } catch (error) {
      this.logger.error(
        `WeChat API ${api} request failed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException(`微信接口调用失败: ${api}`);
    }
  }

  private assertNoError(
    api: string,
    data: { errcode?: number; errmsg?: string },
  ): void {
    if (data.errcode === undefined || data.errcode === 0) {
      return;
    }

    this.logger.warn(`WeChat API ${api} returned ${data.errcode}: ${data.errmsg}`);
    throw new BadGatewayException(
      `微信接口错误(${api}): ${data.errcode} ${data.errmsg ?? ''}`.trim(),
    );
  }
}