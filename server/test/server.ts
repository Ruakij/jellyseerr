import type { Express } from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, before } from 'node:test';

/**
 * Starts the app on 127.0.0.1 for supertest, for the lifetime of the test
 * file. Left to itself, supertest listens on `::` but connects to 127.0.0.1,
 * so on macOS another program bound to 127.0.0.1 on the same port receives
 * the requests.
 */
export function listenOnLocalhost(app: Express): Server {
  const server = app.listen(0, '127.0.0.1');
  before(async () => {
    if (!server.listening) await once(server, 'listening');
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return server;
}
