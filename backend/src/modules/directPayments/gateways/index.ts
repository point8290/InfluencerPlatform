import { env } from '../../../config/env';
import type { PaymentGateway } from './gateway';
import { SimulatedGateway } from './simulatedGateway';
import { StripeGateway } from './stripeGateway';

let gateway: PaymentGateway | null = null;

/**
 * The configured gateway, built once. Returns null when the direct flow is
 * disabled, so the router can answer 404 rather than half-working.
 *
 * One instance per process matters for the simulated gateway: its idempotency
 * cache is in memory, and a second instance would have forgotten every key.
 */
export function getDirectPaymentGateway(): PaymentGateway | null {
  if (env.directPayments.gateway === 'disabled') return null;

  if (gateway === null) {
    gateway = env.directPayments.gateway === 'stripe' ? new StripeGateway() : new SimulatedGateway();
  }
  return gateway;
}

export type { PaymentGateway, ChargeResult, ChargeRequest, PaymentMethodOption } from './gateway';
export { SimulatedGateway } from './simulatedGateway';
