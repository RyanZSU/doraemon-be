import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const MAX_ENTRIES = 1000;

interface AttemptRecord {
  count: number;
  resetAt: number;
}

/**
 * In-memory brute-force protection for password endpoints.
 *
 * Attempts are counted *before* the expensive password/DB work, so parallel
 * requests cannot slip past the limit. App Service currently runs a single
 * instance; move this to a shared store if the app scales out.
 */
@Injectable()
export class LoginAttemptService {
  private readonly attempts = new Map<string, AttemptRecord>();

  /**
   * Counts one attempt and throws 429 once the limit for the window is
   * reached. The caller clears the key after a successful login.
   */
  hit(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || record.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + windowMs });
      this.prune(now);
      return;
    }

    if (record.count >= limit) {
      throw new HttpException(
        '尝试次数过多，请稍后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    if (this.attempts.size <= MAX_ENTRIES) {
      return;
    }

    for (const [key, record] of this.attempts) {
      if (record.resetAt <= now) {
        this.attempts.delete(key);
      }
    }
  }
}
