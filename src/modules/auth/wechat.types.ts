export interface WechatSession {
  openid: string;
  unionid?: string;
}

export interface WechatPhone {
  phoneNumber: string;
  purePhoneNumber: string;
  countryCode: string;
}

export interface Jscode2SessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

export interface StableTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

export interface PhoneNumberResponse {
  errcode?: number;
  errmsg?: string;
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    countryCode?: string;
  };
}