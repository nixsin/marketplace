import { NestFactory } from '@nestjs/core';
import { API_DEFAULT_PORT } from '@medinstru/config/dev-defaults';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
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
