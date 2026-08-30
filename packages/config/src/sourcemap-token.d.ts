export declare const SOURCEMAP_SIGNING_KEY_ENV: string;
export declare const SOURCEMAP_TOKEN_DEFAULT_TTL_SECONDS: number;
export declare const SOURCEMAP_TOKEN_MAX_TTL_SECONDS: number;

export interface SourcemapTokenPayload {
  /** Who minted it. Signed, but readable by anyone holding the token. */
  iss: string;
  /** Distinct per grant, so two tokens for one person stay tellable apart. */
  sid: string;
  iat: number;
  exp: number;
}

export declare function signSourcemapToken(options: {
  issuer: string;
  key: string;
  ttlSeconds?: number;
  now?: number;
}): { token: string; payload: SourcemapTokenPayload };

export declare function verifySourcemapToken(options: {
  token: string | undefined;
  key: string | undefined;
  now?: number;
}):
  | { ok: true; payload: SourcemapTokenPayload }
  | { ok: false; reason: string; payload?: SourcemapTokenPayload };
