// Shape of the JWT payload for an authenticated session (issued by
// AuthService.verifyOtp/completeOnboarding on a *known* user — distinct
// from the short-lived `{ phone, scope: 'onboarding' }` token, which never
// reaches this shape and is rejected by JwtAuthGuard).
export interface AuthTokenPayload {
  sub: string; // user id
  orgId: string;
  role: 'ADMIN' | 'STAFF';
}
