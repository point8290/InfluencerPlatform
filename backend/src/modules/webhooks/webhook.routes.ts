import { Router } from 'express';
import { isTest } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { constructVerifiedEvent, processVerifiedEvent } from './webhook.service';

export const stripeWebhookRouter = Router();

/**
 * The only path by which credits are ever created.
 *
 * Mounted in app.ts with express.raw() ahead of the global express.json(), so
 * `req.body` here is the unparsed Buffer the signature was computed over.
 *
 * Order of operations is the whole point:
 *   1. verify the signature   -> forged requests die before any DB access
 *   2. check the event type   -> anything else is acknowledged and ignored
 *   3. check payment_status   -> 'completed' alone never grants
 *   4. grant, exactly once
 *
 * Response codes are covered in webhook.service.ts: everything verified is a
 * 200 regardless of outcome, because Stripe retries non-2xx and only a
 * transient failure deserves redelivery. A bad signature is the sole 400, and
 * it is raised as an AppError so it leaves through the standard error envelope.
 */
stripeWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const event = constructVerifiedEvent(req.body, req.headers['stripe-signature']);

    const outcome = await processVerifiedEvent(event);

    // One line per delivery, so a duplicate or an unexpected outcome is visible
    // in the server log without reading the database. Traceable by evt_ id,
    // which is what `stripe events resend` takes.
    //
    // Silenced under test only: the suite delivers dozens of webhooks on
    // purpose, and the noise buries the assertions. Signature rejections and
    // unknown payments still log, because those indicate something wrong.
    if (!isTest) {
      console.log(`[webhook] ${event.id} ${event.type} -> ${outcome}`);
    }

    // The outcome is echoed to make `stripe listen` output self-explanatory
    // while tracing duplicate deliveries by hand.
    res.status(200).json({ received: true, event: event.type, outcome });
  }),
);
