/**
 * Declarations for `@medinstru/config/environment`.
 *
 * A separate file rather than a re-export from env-contract.d.ts, because
 * this is a separately exported subpath: a consumer writing
 * `import { detectEnvironment } from "@medinstru/config/environment"` is
 * resolved against THIS file, and declarations living in another module's
 * .d.ts do not describe it.
 */

export type DeployEnvironment =
  | "render"
  | "github-ci"
  | "ci-local"
  | "test"
  | "localhost"
  | "unknown";

/**
 * Every environment, in detection order. A readonly tuple rather than
 * `string[]`, so `(typeof DEPLOY_ENVIRONMENTS)[number]` is the union above
 * rather than widening to `string`.
 */
export declare const DEPLOY_ENVIRONMENTS: readonly [
  "render",
  "github-ci",
  "ci-local",
  "test",
  "localhost",
  "unknown",
];

/**
 * The environment names as named constants, so a call site reads
 * `DEPLOY_ENVIRONMENT.RENDER` rather than a bare "render" string literal
 * that a typo turns into a silently different environment.
 */
export declare const DEPLOY_ENVIRONMENT: {
  readonly RENDER: "render";
  readonly GITHUB_CI: "github-ci";
  readonly CI_LOCAL: "ci-local";
  readonly TEST: "test";
  readonly LOCALHOST: "localhost";
  readonly UNKNOWN: "unknown";
};

/** The name of the variable that narrows inference: `APP_ENV`. */
export declare const APP_ENV_OVERRIDE: string;

/** Human-readable guidance printed when detection lands on `unknown`. */
export declare function unknownEnvironmentHint(): string;

/** Is this process on Render — either the build or the runtime half? */
export declare function isRenderDeploy(env?: NodeJS.ProcessEnv): boolean;

/** Is this a real deployment, and therefore held to the production rules? */
export declare function isDeployedEnvironment(env?: NodeJS.ProcessEnv): boolean;

/** Which environment is this, from platform markers then `APP_ENV`. */
export declare function detectEnvironment(
  env?: NodeJS.ProcessEnv,
): DeployEnvironment;
