/**
 * Declarations for `@medinstru/config/dev-defaults`.
 *
 * Its own file because it is its own subpath: a consumer importing
 * `@medinstru/config/dev-defaults` resolves against THIS declaration, and
 * declarations living in index.d.ts do not describe it.
 */

// ---------------------------------------------------------------------
// Localhost values, shared so nothing repeats a literal
// ---------------------------------------------------------------------
//
// Deliberately NOT literal types. These are the localhost defaults the env
// contract writes into .env.example and the dev stack reads; a consumer
// wants the value, never a type narrowed to one particular port. Narrowing
// them would make `PORT: number = API_DEFAULT_PORT` fine and
// `let p = API_DEFAULT_PORT; p = 5000` an error, which is the wrong shape
// for a default.
export declare const POSTGRES_PORT: number;
export declare const REDIS_PORT: number;
export declare const API_DEFAULT_PORT: number;
export declare const WEB_DEFAULT_PORT: number;

export declare const DEV_POSTGRES_USER: string;
export declare const DEV_POSTGRES_PASSWORD: string;
export declare const DEV_POSTGRES_DB: string;

export declare const DEV_DATABASE_URL: string;
export declare const DOCKER_DATABASE_URL: string;
export declare const DOCKER_REDIS_URL: string;

export declare const DEV_API_URL: string;
export declare const DEV_SITE_URL: string;
export declare const DEV_BLOB_BASE_URL: string;
