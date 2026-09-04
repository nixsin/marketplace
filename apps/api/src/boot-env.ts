/**
 * Loading .env before the environment contract is checked.
 *
 * Its own module rather than a function inside main.ts, so it can be tested
 * without importing an entrypoint whose top level starts a server. Same
 * reason security-headers.ts was pulled out of next.config.ts: logic that
 * decides whether a process may proceed should not be the part verified
 * only by hand.
 *
 * This module must stay side-effect free -- main.ts imports it statically,
 * before the check, and anything that read configuration at import time
 * would defeat the ordering main.ts exists to guarantee.
 */

/**
 * Apply .env to process.env, if there is one.
 *
 * | Case | Behaviour |
 * |---|---|
 * | no .env (Render, CI) | nothing to do; the platform supplies the env |
 * | .env present | values applied, existing variables untouched |
 * | .env unreadable or malformed | rethrown |
 *
 * Precedence matches ConfigModule's: a real environment variable always
 * beats the file, so calling this and letting ConfigModule load the same
 * file again changes no value. That is the rule that decides which
 * DATABASE_URL wins inside the dev container.
 *
 * A missing file is swallowed because it is the normal case on a
 * deployment. Every other failure is rethrown: an unreadable .env is a real
 * fault, and swallowing it would present as a pile of "not declared" errors
 * naming the very variables the file sets -- pointing whoever reads them at
 * the wrong problem.
 */
export function loadEnvFileIfPresent(
  load: () => void = () => process.loadEnvFile(),
) {
  try {
    load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
