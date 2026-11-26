import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Requires a reachable MongoDB and the same environment variables as the app
 * (see .env.example). Skipped when MONGODB_URI is not set so `npm test` and CI
 * do not need a database.
 *
 * AppModule is imported dynamically because its ConfigModule validates the
 * environment as soon as the module is loaded.
 */
const describeIfDb = process.env.MONGODB_URI ? describe : describe.skip;

describeIfDb('App (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/live -> ok', async () => {
    const response = await request(server).get('/api/health/live').expect(200);

    expect(response.body.code).toBe(0);
    expect(response.body.data.status).toBe('ok');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/users/me without a token -> 401', async () => {
    const response = await request(server).get('/api/users/me').expect(401);

    expect(response.body.code).toBe(401);
    expect(response.body.data).toBeNull();
  });
});