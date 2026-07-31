import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { stripeWebhookRouter } from './modules/webhooks/webhook.routes';
import { authRouter } from './modules/auth/auth.routes';
import { currencyRouter } from './modules/currencies/currency.routes';
import { paymentRouter } from './modules/payments/payment.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { campaignRouter } from './modules/campaigns/campaign.routes';

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

  app.use('/api/auth', authRouter);
  app.use('/api/currencies', currencyRouter);
  app.use('/api/payments', paymentRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/campaigns', campaignRouter);

  // Must stay last: unmatched routes, then the single error responder.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
