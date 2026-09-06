import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapTestApp } from './helpers/bootstrap';

// `/` looks like leftover scaffolding and is not: render.yaml sets
// `healthCheckPath: /`, so this route is what Render polls to decide the
// service is alive. A 200 here is the difference between a deploy going live
// and being rolled back.
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    ({ app } = await bootstrapTestApp());
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
