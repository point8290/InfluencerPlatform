import { Router } from 'express';

export const stripeWebhookRouter = Router();

/**
 * Placeholder for the Stripe webhook handler (step 4: signature verification,
 * two-tier payment resolution, and the grant transaction).
 *
 * The route exists from the first commit purely so that the raw-body mount
 * ordering in app.ts is established before anything can violate it. Adding the
 * route later would mean a stretch of history in which express.json() had
 * already consumed the request stream — and a signature check written against
 * that would have failed for reasons unrelated to the signature.
 *
 * `details` reports whether the body arrived as raw bytes, which makes the
 * ordering verifiable with curl right now, before Stripe is involved at all.
 */
stripeWebhookRouter.post('/', (req, res) => {
  const receivedRawBody = Buffer.isBuffer(req.body);

  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Stripe webhook handling is implemented in step 4.',
      details: [
        {
          field: 'raw_body',
          message: receivedRawBody
            ? 'Body received as a Buffer — raw mount is ahead of express.json().'
            : `Body was parsed before reaching this route (got ${typeof req.body}). ` +
              'The raw mount ordering in app.ts is broken.',
        },
      ],
    },
  });
});
