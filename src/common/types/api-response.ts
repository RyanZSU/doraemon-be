/**
 * Success responses use code 0. Error responses reuse the HTTP status as the
 * business code (e.g. 401, 404, 502) so the mini program can branch on one
 * field.
 */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
  requestId?: string;
  timestamp: string;
}

export interface ApiErrorResponse extends ApiResponse<null> {
  details?: string[];
}