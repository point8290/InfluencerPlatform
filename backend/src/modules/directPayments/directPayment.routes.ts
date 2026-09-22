import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { ValidationError } from '../../lib/errors';
import { authenticatedUserId, requireAuth } from '../../middleware/requireAuth';
import {
  createDirectPayment,
  getDirectPayment,
  getDirectPaymentConfig,
  reconcileDirectPayment,
} from './directPayment.service';

export const directPaymentRouter = Router();

// Everything here is the authenticated user's own payment data.
directPaymentRouter.use(requireAuth);

function paymentIdFrom(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('Payment id must be a positive integer.', [
      { field: 'id', message: `Received "${String(raw)}".` },
    ]);
  }
  return id;
}

directPaymentRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json(getDirectPaymentConfig());
  }),
);

directPaymentRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const result = await createDirectPayment(
      authenticatedUserId(req),
      req.body,
      req.headers['idempotency-key'],
    );

    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    // 201 whatever the charge outcome: the payment resource was created (or
    // replayed) and its body says how the charge went. A declined card is a
    // payment result, not an HTTP error.
    res.status(201).json(result.payload);
  }),
);

directPaymentRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getDirectPayment(authenticatedUserId(req), paymentIdFrom(req.params.id)));
  }),
);

directPaymentRouter.post(
  '/:id/reconcile',
  asyncHandler(async (req, res) => {
    res.json(await reconcileDirectPayment(authenticatedUserId(req), paymentIdFrom(req.params.id)));
  }),
);
