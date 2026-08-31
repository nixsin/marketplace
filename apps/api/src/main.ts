// Load .env BEFORE anything else, including the environment check below.
//
// ORDERING BUG, found by running it: `ConfigModule.forRoot()` is what loads
// .env, and that happens inside `NestFactory.create(AppModule)` -- so a check
// placed before Nest boots sees an empty environment and fails every local
// start despite a perfectly good .env sitting right there. Loading it
// explicitly here is what makes "check before anything else" and "read the
// developer's .env" both true.
//
// A no-op in production: Render injects real environment variables and the
// image contains no .env file, so this finds nothing and changes nothing.
// dotenv never overwrites a variable that is already set, which is also why
// it is safe to call twice (ConfigModule calls it again moments later).
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { API_DEFAULT_PORT } from '@medinstru/config';
import { assertEnvOrExit } from '@medinstru/config/env-contract';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // The ONLY hook that actually runs in production. The prod image's CMD is
  // `node dist/src/main.js`, so a `prestart` npm hook would work locally and
  // silently do nothing in the container -- the exact silent-skip shape this
  // repo has been bitten by more than once.
  //
  // Before NestFactory.create, so a misconfigured deploy never opens a
  // database connection or constructs a Redis client on its way to failing.
  // It never binds a port either, so Render marks the deploy failed and keeps
  // the previous healthy version live. Booting and then misbehaving is the
  // worse outcome: an API with no INQUIRY_IP_HASH_SECRET serves traffic
  // perfectly while one of the abuse controls on an unauthenticated endpoint
  // has quietly stopped running.
  assertEnvOrExit({ app: 'api' });

  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // API_DEFAULT_PORT, not a literal here. The number used to be written out
  // in this file, in .env.example, in docker-compose.yml and in render.yaml,
  // and the one in this file was 3000 -- the WEB app's port -- so a missing
  // PORT bound the API on top of the web dev server and the failure surfaced
  // as the web app refusing to start. One definition, in @medinstru/config,
  // is what makes that class of drift impossible rather than unlikely.
  //
  // Reached only if PORT is genuinely absent, which the check above has
  // already reported: every environment declares every variable.
  await app.listen(process.env.PORT ?? API_DEFAULT_PORT);
}
bootstrap();
