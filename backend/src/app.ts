import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { stripeWebhookRouter } from './modules/webhooks/webhook.routes';

/**
 * Builds the Express application without binding a port, so tests can drive it
 * through supertest and src/server.ts remains the only place that listens.
 */
export function createApp(): express.Express {
  const app = express();

  app.use(cors({ origin: env.frontendUrl }));

  // ───────────────────────────────────────────────────────────────────────
  // THE ORDER OF THE NEXT TWO MOUNTS IS LOAD-BEARING. DO NOT REORDER.
  //
  // Stripe signs the exact bytes of the request body. Verifying the
  // Stripe-Signature header therefore requires those bytes, unmodified.
  // express.json() consumes the request stream and leaves behind a parsed
  // object — re-serializing it would not reproduce Stripe's payload
  // byte-for-byte, so every signature check would fail.
  //
  // Mounting the webhook with express.raw() BEFORE the global JSON parser is
  // what keeps the raw body available. This is not a style preference.
  //
  // See DESIGN.md → "Buy credits" and docs/API.md → POST /api/webhooks/stripe.
  // ───────────────────────────────────────────────────────────────────────
  app.use(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookRouter,
  );

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', environment: env.nodeEnv });
  });

  // Feature routers are mounted here as they arrive:
  //   step 3 — /api/auth
  //   step 4 — /api/payments, /api/currencies
  //   step 5 — /api/wallet, /api/campaigns

  // Must stay last: unmatched routes, then the single error responder.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
