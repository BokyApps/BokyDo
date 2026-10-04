/** Stable machine-readable error codes returned as `{ error: code }`. */
export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'password_change_required'
  | 'setup_required'
  | 'csrf_failed'
  | 'invalid_credentials'
  | 'too_many_requests'
  | 'weak_password'
  | 'not_found'
  | 'conflict'
  | 'internal_error';

export interface ApiError {
  error: ApiErrorCode | string;
  message?: string;
  issues?: { path: string; message: string }[];
}
