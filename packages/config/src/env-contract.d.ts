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
  levels: Partial<Record<DeployEnvironment, Severity>>;
  check?: (value: string) => string | null;
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
