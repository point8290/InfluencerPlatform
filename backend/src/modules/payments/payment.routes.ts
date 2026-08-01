import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticatedUserId, requireAuth } from '../../middleware/requireAuth';
import { ValidationError } from '../../lib/errors';
import { createCheckoutSession, getPaymentBySessionId } from './payment.service';

export const paymentRouter = Router();

// Everything here is the authenticated user's own payment data.
paymentRouter.use(requireAuth);

paymentRouter.post(
  '/checkout-session',
  asyncHandler(async (req, res) => {
    const result = await createCheckoutSession(
      authenticatedUserId(req),
      req.body,
      // Optional. Supplying it makes a retried POST return the original session
      // instead of creating a second payable one.
      req.headers['idempotency-key'],
    );

    // Mirrors Stripe's own header, so a caller can tell a replay from a fresh
    // creation without the response body differing. The status stays 201: an
    // idempotent replay must be indistinguishable from the original response.
    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }

    res.status(201).json(result.payload);
  }),
);

paymentRouter.get(
  '/session/:stripeSessionId',
  asyncHandler(async (req, res) => {
    const { stripeSessionId } = req.params;

    if (stripeSessionId === undefined || stripeSessionId.trim() === '') {
      throw new ValidationError('A checkout session id is required.', [
        { field: 'stripeSessionId', message: 'Path parameter is required.' },
      ]);
    }

    res.json(await getPaymentBySessionId(authenticatedUserId(req), stripeSessionId));
  }),
);
