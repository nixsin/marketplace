import { NestFactory } from '@nestjs/core';
import { API_DEFAULT_PORT } from '@medinstru/config/dev-defaults';
import { assertBootEnv } from '@medinstru/config/env-contract';
import { loadEnvFileIfPresent } from './boot-env';

// Its own module so the ENOENT-vs-rethrow behaviour is testable without
// importing this file, whose top level starts a server. Side-effect free by
// design, so importing it statically cannot read configuration before the
// check below -- and neither can dev-defaults, which is plain constants.
loadEnvFileIfPresent();

// The first thing this process does. A missing variable otherwise surfaces
// as whatever the code that reads it happens to do -- a Prisma connection
// error, an undefined interpolated into a URL, or nothing at all until the
// first request. See CLAUDE.md's "Startup environment contract".
assertBootEnv({ app: 'api' });

async function bootstrap() {
  // AppModule is imported HERE, not at the top of the file, and that is
  // load-bearing rather than style. Static imports are evaluated before any
  // module-body statement, and `ConfigModule.forRoot({ isGlobal: true })` is
  // an argument to AppModule's @Module decorator -- so it is invoked while
  // the module is being imported, not when Nest initialises it. Confirmed
  // directly: importing app.module and nothing else already populates
  // process.env from .env.
  //
  // With a static import the whole provider tree would therefore be
  // evaluated before the check could report anything, and any import-time
  // failure would preempt it -- replacing a report that names every missing
  // variable with whichever stack trace happened to fire first. Deferring
  // the import keeps the check genuinely first.
  const { AppModule } = await import('./app.module.js');
  const { configureApp } = await import('./app.setup.js');

  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // The fallback must be the port this service is KNOWN BY, not an unrelated
  // number. It was 3000 while both Dockerfile stages EXPOSE 4000, so a deploy
  // that lost PORT bound a port nothing was looking for: Nest logged
  // "successfully started", Render's port scan found nothing, and the deploy
  // timed out with an error naming neither PORT nor 3000. Observed live on
  // 2026-09-04 -- production kept serving from the previous instance, which
  // is the only reason it was a stuck deploy rather than an outage.
  //
  // Shared with the Dockerfile's EXPOSE and the contract's devValue through
  // API_DEFAULT_PORT rather than written out again; a literal here is the
  // thing that drifted. scripts/api-port-drift.test.mjs pins them together.
  await app.listen(process.env.PORT ?? API_DEFAULT_PORT);
}
bootstrap();
