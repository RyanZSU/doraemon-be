import type { UserProfile } from '../users/user-profile.js';

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  isNewUser: boolean;
  user: UserProfile;
}