export type DeployEnvironment =
  | "render"
  | "github-ci"
  | "ci-local"
  | "test"
  | "localhost"
  | "unknown";
export type Severity = "required" | "recommended" | "optional";

export interface EnvRule {
  name: string;
  /** Never echo this variable's value into a message — the file is committed and the messages reach logs. */
  secret: boolean;
  why: string;
  /**
   * What `NAME=` means for this variable, or null when empty is not a valid
   * value. Absent is ALWAYS an error: every environment declares every
   * variable, so `undefined` means somebody forgot rather than turned it off.
   */
  emptyMeans: string | null;
  check: (value: string) => string | null;
  /** Extra rules for the VALUE in specific environments. */
  perEnvironment?: Partial<
    Record<DeployEnvironment, (value: string) => string | null>
  >;
}

export interface Finding {
  level: "error" | "warning";
  message: string;
}

export interface CheckResult {
  environment: DeployEnvironment;
  app: "api" | "web";
  errors: Finding[];
  warnings: Finding[];
  ok: boolean;
}

export declare const DEPLOY_ENVIRONMENTS: readonly DeployEnvironment[];
export declare const APP_ENV_OVERRIDE: string;
export declare const UNKNOWN_ENVIRONMENT_HINT: string;

export declare function isRenderDeploy(
  env?: Record<string, string | undefined>,
): boolean;

/** The question app code should ask: am I deployed, whatever the platform? */
export declare function isDeployedEnvironment(
  env?: Record<string, string | undefined>,
): boolean;

export declare const DEPLOY_ENVIRONMENT: Record<string, DeployEnvironment>;

export declare function displayValue(
  rule: EnvRule,
  raw: string | undefined,
): string;

export declare function formatStartupBanner(
  result: CheckResult,
  env: Record<string, string | undefined>,
): string;

export declare function formatMatrix(app: "api" | "web"): string;

export declare function expectationsFor(
  app: "api" | "web",
  environment: DeployEnvironment,
): {
  declared: string[];
  mayBeEmpty: { name: string; means: string }[];
  extraValueRules: string[];
};
export declare const API_ENV_CONTRACT: EnvRule[];
export declare const WEB_ENV_CONTRACT: EnvRule[];
export declare const CONTRACTS: Record<"api" | "web", EnvRule[]>;
export declare const CROSS_CHECKS: Record<
  string,
  ((
    env: Record<string, string | undefined>,
    environment: DeployEnvironment,
  ) => Finding | null)[]
>;

export declare function detectEnvironment(
  env?: Record<string, string | undefined>,
): DeployEnvironment;

export declare function checkEnv(options: {
  app: "api" | "web";
  env?: Record<string, string | undefined>;
  environment?: DeployEnvironment;
}): CheckResult;

export declare function formatReport(result: CheckResult): string;

export declare function assertEnvOrExit(options: {
  app: "api" | "web";
  env?: Record<string, string | undefined>;
  exit?: (code: number) => never;
  log?: (message: string) => void;
}): CheckResult;
