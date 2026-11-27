export interface AuthenticatedUser {
  userId: string;
  phone: string | null;
  openid: string | null;
}

export interface JwtPayload {
  sub: string;
  phone: string | null;
  openid: string | null;
  iat?: number;
  exp?: number;
}
