export interface AuthenticatedUser {
  userId: string;
  phone: string;
}

export interface JwtPayload {
  sub: string;
  phone: string;
  iat?: number;
  exp?: number;
}