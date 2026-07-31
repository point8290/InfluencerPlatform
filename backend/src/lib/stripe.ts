import Stripe from 'stripe';
import { requireStripeSecretKey } from '../config/env';

let client: Stripe | null = null;

/**
 * The Stripe client, constructed on first use rather than at import time.
 *
 * Lazy on purpose: constructing it eagerly would read STRIPE_SECRET_KEY as a
 * side effect of importing this module, so any test or script that transitively
 * touched it would refuse to run without a key it never uses.
 *
 * The API version is not pinned here — the SDK pins the version its own types
 * were generated against, so pinning separately risks the two disagreeing.
 */
export function getStripe(): Stripe {
  if (client === null) {
    client = new Stripe(requireStripeSecretKey());
  }
  return client;
}
