import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import { env } from '../../config/env';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../../lib/errors';
import { isUniqueViolation } from '../../lib/isUniqueViolation';
import {
  Currency,
  Payment,
  PaymentAttempt,
  sequelize,
  type AttemptOutcome,
  type AttemptTrigger,
  type DirectPaymentOptions,
} from '../../models';
import { applyPurchaseGrant } from '../payments/grant.service';
import { readIdempotencyKey } from '../payments/payment.service';
import { quotePurchase, type PriceQuote } from '../payments/pricing.service';
import {
  getDirectPaymentGateway,
  SimulatedGateway,
  type ChargeResult,
  type PaymentGateway,
} from './gateways';
import { backoffDelayMs, decideNextStep, type NextStep } from './retryPolicy';

/**
 * SERVER-DRIVEN PAYMENTS, WITH RETRIES
 *
 * In the Checkout flow the browser pays Stripe directly and this server only
 * hears about it. Here the server itself calls the gateway to charge, which is
 * what makes an automatic retry possible:
 *
 *   1. INSERT the payment (pending) — the local record precedes the charge,
 *      exactly as in the Checkout flow.
 *   2. Call the gateway with an idempotency key for attempt 1.
 *   3. Classify the answer (retryPolicy.decideNextStep) and either settle, or
 *      back off and retry:
 *        transient error      -> SAME key  (the gateway executes it at most once)
 *        retryable decline    -> NEW key   (the last attempt definitely failed)
 *        hard decline / 3DS   -> stop
 *        budget spent on a transient, or unknown -> leave pending, reconcile
 *   4. On success, grant through the same exactly-once path as the webhook.
 *
 * Every gateway call is written to payment_attempts BEFORE it is made and
 * updated after, so a crash mid-call leaves an 'in_flight' row that
 * reconciliation can finish.
 *
 * The retry loop runs inside the HTTP request, which keeps this flow easy to
 * follow and test. A production system would run it on a job queue, so a slow
 * gateway ties up a worker rather than a request, and a crash resumes from the
 * queue rather than waiting for someone to press Reconcile.
 */

const MAX_SIMULATED_FAILURES = 10;
const DEFAULT_SIMULATED_FAILURES = 1;

/**
 * How long a processing claim is honoured. Well above the longest possible run
 * (cap retries × max backoff + gateway latency), so a live run is never
 * overtaken; short enough that a claim orphaned by a crash expires on its own.
 */
const CLAIM_STALE_AFTER_MS = 2 * 60 * 1000;

function requireGateway(): PaymentGateway {
  const gateway = getDirectPaymentGateway();
  if (gateway === null) {
    throw new NotFoundError('Direct payments are disabled on this server.');
  }
  return gateway;
}

/** What the UI needs to render the form: gateway, retry limits, test instruments. */
export function getDirectPaymentConfig(): unknown {
  const gateway = requireGateway();
  const { retry } = env.directPayments;

  return {
    gateway: gateway.name,
    default_max_retries: retry.defaultMaxRetries,
    max_retries_cap: retry.maxRetriesCap,
    max_simulated_failures: gateway.name === 'simulated' ? MAX_SIMULATED_FAILURES : 0,
    base_delay_ms: retry.baseDelayMs,
    max_delay_ms: retry.maxDelayMs,
    payment_methods: gateway.paymentMethods.map((method) => ({
      id: method.id,
      label: method.label,
      description: method.description,
      uses_failure_count: gateway.name === 'simulated' && method.usesFailureCount,
    })),
  };
}

type RequestedOptions = Omit<DirectPaymentOptions, 'keyNonce'>;

function readOptionalInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
  details: ErrorDetail[],
): number {
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    details.push({ field, message: `${field} must be an integer from ${min} to ${max}.` });
    return fallback;
  }
  return value;
}

function readDirectOptions(body: unknown, gateway: PaymentGateway): RequestedOptions {
  const input = (body ?? {}) as Record<string, unknown>;
  const details: ErrorDetail[] = [];
  const { retry } = env.directPayments;

  const paymentMethod = input.payment_method;
  if (typeof paymentMethod !== 'string' || !gateway.paymentMethods.some((m) => m.id === paymentMethod)) {
    details.push({
      field: 'payment_method',
      message: `payment_method must be one of: ${gateway.paymentMethods.map((m) => m.id).join(', ')}.`,
    });
  }

  // The client may choose its retry budget, but only up to the server's cap: a
  // client must never be able to make this server hammer a gateway.
  const maxRetries = readOptionalInt(
    input.max_retries,
    'max_retries',
    0,
    retry.maxRetriesCap,
    retry.defaultMaxRetries,
    details,
  );

  const simulatedFailures =
    gateway.name === 'simulated'
      ? readOptionalInt(
          input.simulated_failures,
          'simulated_failures',
          0,
          MAX_SIMULATED_FAILURES,
          DEFAULT_SIMULATED_FAILURES,
          details,
        )
      : 0;

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }
  return { paymentMethod: paymentMethod as string, maxRetries, simulatedFailures };
}

/**
 * One key per ATTEMPT. Re-sends of an attempt reuse it; a new attempt gets the
 * next number. Deterministic, so reconciliation can recompute any attempt's key
 * — and it is stored on every payment_attempts row regardless.
 */
function attemptKey(payment: Payment, attemptNumber: number): string {
  return `direct-${payment.id}-${payment.directOptions!.keyNonce}-attempt-${attemptNumber}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Processing claim ───────────────────────────────────────────────────────

/**
 * Takes the right to call the gateway for this payment, or reports that
 * someone else holds it. One UPDATE, so two requests cannot both win.
 */
async function claimProcessing(paymentId: number): Promise<boolean> {
  const [affected] = await Payment.update(
    { processingStartedAt: new Date() },
    {
      where: {
        id: paymentId,
        status: 'pending',
        [Op.or]: [
          { processingStartedAt: null },
          { processingStartedAt: { [Op.lt]: new Date(Date.now() - CLAIM_STALE_AFTER_MS) } },
        ],
      },
    },
  );
  return affected === 1;
}

async function releaseProcessing(paymentId: number): Promise<void> {
  await Payment.update({ processingStartedAt: null }, { where: { id: paymentId } });
}

// ── One gateway call, recorded ─────────────────────────────────────────────

const OUTCOME_BY_KIND: Record<ChargeResult['kind'], AttemptOutcome> = {
  succeeded: 'succeeded',
  requires_action: 'requires_action',
  declined: 'declined',
  transient: 'transient_error',
  unknown: 'unknown',
};

interface CallSpec {
  payment: Payment;
  gateway: PaymentGateway;
  callNumber: number;
  attemptNumber: number;
  trigger: AttemptTrigger;
  delayBeforeMs: number;
  /** Look an existing charge up instead of (re-)sending one. */
  retrieveReference?: string;
}

async function callGateway(spec: CallSpec): Promise<ChargeResult> {
  const { payment, gateway } = spec;
  const options = payment.directOptions!;
  const idempotencyKey = attemptKey(payment, spec.attemptNumber);

  // Written BEFORE the call. If the process dies mid-call this row stays
  // 'in_flight' — the durable trace that a charge may have happened.
  const attempt = await PaymentAttempt.create({
    paymentId: payment.id,
    callNumber: spec.callNumber,
    attemptNumber: spec.attemptNumber,
    idempotencyKey,
    trigger: spec.trigger,
    delayBeforeMs: spec.delayBeforeMs,
  });

  const startedAt = Date.now();
  let result: ChargeResult;
  try {
    result =
      spec.retrieveReference !== undefined
        ? await gateway.retrieve(spec.retrieveReference)
        : await gateway.charge({
            paymentId: payment.id,
            idempotencyKey,
            amountPaise: payment.amountPaise,
            description: `${payment.credits} credits (payment ${payment.id})`,
            paymentMethod: options.paymentMethod,
            simulatedFailures: options.simulatedFailures,
          });
  } catch (error) {
    // Not a payment outcome — a bug or misconfiguration. Recorded as unknown
    // (the request may still have reached the gateway), then surfaced as a 500.
    await attempt.update({
      outcome: 'unknown',
      errorCode: 'internal_error',
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  await attempt.update({
    outcome: OUTCOME_BY_KIND[result.kind],
    errorCode: result.kind === 'succeeded' ? null : result.code,
    errorMessage: result.kind === 'succeeded' ? null : result.message.slice(0, 512),
    gatewayReference: 'reference' in result ? result.reference : null,
    replayed: 'replayed' in result ? result.replayed : false,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

// ── Settling ───────────────────────────────────────────────────────────────

/**
 * Grants a direct payment — at most once. Mirrors the webhook's grant: lock the
 * row, check it is still pending, grant; a duplicate that slips past the check
 * dies on UNIQUE(ledger.payment_id).
 */
async function grantDirectPayment(paymentId: number, reference: string): Promise<void> {
  try {
    await sequelize.transaction(async (transaction) => {
      const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
      if (payment === null) throw new Error(`Payment ${paymentId} vanished while being granted.`);
      if (payment.status === 'paid') return;

      if (payment.status !== 'pending') {
        // Money was taken for a payment already written off. Unreachable by
        // construction — only pending payments are ever charged — but if it
        // happens it needs a human and a refund, not a silent grant.
        console.error(
          `[direct-payments] gateway charged payment ${paymentId} (${reference}) but it is "${payment.status}". Refund required.`,
        );
        return;
      }

      if (reference.startsWith('pi_') && payment.stripePaymentIntentId === null) {
        await payment.update({ stripePaymentIntentId: reference }, { transaction });
      }
      await applyPurchaseGrant(payment, transaction);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_ledger_payment_id')) return;
    throw error;
  }
}

async function settle(paymentId: number, step: NextStep, result: ChargeResult): Promise<void> {
  if (step === 'grant' && result.kind === 'succeeded') {
    await grantDirectPayment(paymentId, result.reference);
    return;
  }
  if (step === 'fail' || step === 'needs_customer') {
    // Conditional on 'pending', so it can never demote a paid payment.
    await Payment.update({ status: 'failed' }, { where: { id: paymentId, status: 'pending' } });
  }
  // 'reconcile': deliberately nothing. The payment stays pending — it may have
  // been charged, and writing it off would be a lie the customer pays for.
}

// ── The retry loop ─────────────────────────────────────────────────────────

async function chargeWithRetries(payment: Payment, gateway: PaymentGateway): Promise<void> {
  const { maxRetries } = payment.directOptions!;
  const backoff = env.directPayments.retry;

  let attemptNumber = 1;
  let retriesUsed = 0;
  let delayBeforeMs = 0;
  let trigger: AttemptTrigger = 'initial';

  for (let callNumber = 1; ; callNumber += 1) {
    if (delayBeforeMs > 0) await sleep(delayBeforeMs);

    const result = await callGateway({
      payment,
      gateway,
      callNumber,
      attemptNumber,
      trigger,
      delayBeforeMs,
    });

    const step = decideNextStep(result, retriesUsed, maxRetries);

    if (step === 'retry_same_key' || step === 'retry_new_key') {
      retriesUsed += 1;
      if (step === 'retry_new_key') attemptNumber += 1;
      delayBeforeMs = backoffDelayMs(retriesUsed, backoff);
      trigger = 'retry';
      continue;
    }

    await settle(payment.id, step, result);
    return;
  }
}

// ── Public operations ──────────────────────────────────────────────────────

export interface DirectPaymentResult {
  replayed: boolean;
  payload: unknown;
}

function assertSameRequest(existing: Payment, quote: PriceQuote, options: RequestedOptions): void {
  const stored = existing.directOptions;
  const same =
    existing.channel === 'direct' &&
    stored !== null &&
    existing.currencyId === quote.currency.id &&
    existing.credits === quote.credits &&
    existing.amountPaise === quote.amountPaise &&
    stored.paymentMethod === options.paymentMethod &&
    stored.maxRetries === options.maxRetries &&
    stored.simulatedFailures === options.simulatedFailures;

  if (!same) {
    throw new ConflictError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different purchase. ' +
        'Generate a new key for a new purchase.',
    );
  }
}

/**
 * Creates a direct payment and charges it, retrying per the policy.
 *
 * A repeated request with the same Idempotency-Key returns the payment as it
 * stands and never charges again — the client-facing idempotency layer, on top
 * of the gateway-facing one.
 */
export async function createDirectPayment(
  userId: number,
  body: unknown,
  rawIdempotencyKey?: unknown,
): Promise<DirectPaymentResult> {
  const gateway = requireGateway();
  const quote = await quotePurchase(body);
  const options = readDirectOptions(body, gateway);
  const idempotencyKey = readIdempotencyKey(rawIdempotencyKey);

  if (idempotencyKey !== null) {
    const existing = await Payment.findOne({ where: { userId, idempotencyKey } });
    if (existing !== null) {
      assertSameRequest(existing, quote, options);
      return { replayed: true, payload: await buildView(existing.id) };
    }
  }

  let payment: Payment;
  try {
    payment = await Payment.create({
      userId,
      currencyId: quote.currency.id,
      planId: quote.plan?.id ?? null,
      purchaseKind: quote.purchaseKind,
      credits: quote.credits,
      amountPaise: quote.amountPaise,
      status: 'pending',
      idempotencyKey,
      channel: 'direct',
      directOptions: { ...options, keyNonce: randomUUID().slice(0, 8) },
      // Claimed at birth: nobody else can start charging this row while the
      // request that created it is still running.
      processingStartedAt: new Date(),
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_payments_user_idempotency_key') && idempotencyKey !== null) {
      const winner = await Payment.findOne({ where: { userId, idempotencyKey } });
      if (winner !== null) {
        assertSameRequest(winner, quote, options);
        return { replayed: true, payload: await buildView(winner.id) };
      }
    }
    throw error;
  }

  try {
    await chargeWithRetries(payment, gateway);
  } finally {
    await releaseProcessing(payment.id);
  }

  return { replayed: false, payload: await buildView(payment.id) };
}

/**
 * Resolves a payment left pending — retries exhausted on transient errors, an
 * unknown outcome, or a process that died mid-call.
 *
 * One gateway call, no automatic retries:
 *   - the last call returned a gateway reference -> look the charge up;
 *   - otherwise -> re-send the LAST attempt under its SAME key. If that attempt
 *     charged, the gateway replays the success; if it never executed, it runs
 *     now — either way, at most one charge for that key.
 */
export async function reconcileDirectPayment(userId: number, paymentId: number): Promise<unknown> {
  const gateway = requireGateway();
  const payment = await findOwnedDirectPayment(userId, paymentId);

  if (payment.status !== 'pending') return buildView(payment.id);

  if (!(await claimProcessing(payment.id))) {
    throw new ConflictError(
      'PAYMENT_IN_PROGRESS',
      'This payment is being processed by another request. Retry shortly.',
    );
  }

  try {
    const last = await PaymentAttempt.findOne({
      where: { paymentId: payment.id },
      order: [['callNumber', 'DESC']],
    });

    const retrieveReference =
      last?.outcome === 'unknown' && last.gatewayReference !== null ? last.gatewayReference : undefined;

    const result = await callGateway({
      payment,
      gateway,
      callNumber: (last?.callNumber ?? 0) + 1,
      attemptNumber: last?.attemptNumber ?? 1,
      trigger: 'reconcile',
      delayBeforeMs: 0,
      retrieveReference,
    });

    // No retry budget here: a transient answer leaves the payment pending for
    // the next reconciliation, a decline settles it.
    await settle(payment.id, decideNextStep(result, 0, 0), result);
  } finally {
    await releaseProcessing(payment.id);
  }

  return buildView(payment.id);
}

export async function getDirectPayment(userId: number, paymentId: number): Promise<unknown> {
  requireGateway();
  const payment = await findOwnedDirectPayment(userId, paymentId);
  return buildView(payment.id);
}

async function findOwnedDirectPayment(userId: number, paymentId: number): Promise<Payment> {
  // Scoped to the user: another user's payment is indistinguishable from none.
  const payment = await Payment.findOne({ where: { id: paymentId, userId, channel: 'direct' } });
  if (payment === null) throw new NotFoundError(`No direct payment with id ${paymentId}.`);
  return payment;
}

// ── Response shape ─────────────────────────────────────────────────────────

/**
 * The payment's status is the durable fact (pending | paid | failed). `state`
 * is what it MEANS right now, which is what a screen needs to decide what to
 * offer:
 *   processing            a request is charging it now
 *   needs_reconciliation  pending with nobody working on it — outcome unknown
 *   requires_customer     stopped for 3-D Secure / OTP
 */
function deriveState(payment: Payment, attempts: PaymentAttempt[]): string {
  if (payment.status === 'paid') return 'paid';

  const last = attempts[attempts.length - 1];
  if (payment.status === 'failed') {
    return last?.outcome === 'requires_action' ? 'requires_customer' : 'failed';
  }

  const claimed =
    payment.processingStartedAt !== null &&
    payment.processingStartedAt.getTime() > Date.now() - CLAIM_STALE_AFTER_MS;
  return claimed ? 'processing' : 'needs_reconciliation';
}

async function buildView(paymentId: number): Promise<unknown> {
  const payment = await Payment.findByPk(paymentId, {
    include: [
      { model: Currency, as: 'currency' },
      { model: PaymentAttempt, as: 'attempts' },
    ],
    order: [[{ model: PaymentAttempt, as: 'attempts' }, 'callNumber', 'ASC']],
  });
  if (payment === null) throw new NotFoundError(`No direct payment with id ${paymentId}.`);

  const attempts = payment.attempts ?? [];
  const options = payment.directOptions;
  const gateway = getDirectPaymentGateway();

  return {
    payment_id: payment.id,
    status: payment.status,
    state: deriveState(payment, attempts),
    credits: payment.credits,
    amount_paise: payment.amountPaise,
    currency_code: payment.currency?.code ?? null,
    gateway: gateway?.name ?? null,
    payment_method: options?.paymentMethod ?? null,
    max_retries: options?.maxRetries ?? null,
    simulated_failures: gateway?.name === 'simulated' ? (options?.simulatedFailures ?? null) : null,
    // Ground truth from the simulated gateway: how many times money was taken.
    // Whatever the retries did, this must never exceed 1.
    gateway_charge_count:
      gateway instanceof SimulatedGateway ? gateway.chargesFor(payment.id) : null,
    attempts: attempts.map((attempt) => ({
      call_number: attempt.callNumber,
      attempt_number: attempt.attemptNumber,
      idempotency_key: attempt.idempotencyKey,
      trigger: attempt.trigger,
      outcome: attempt.outcome,
      error_code: attempt.errorCode,
      error_message: attempt.errorMessage,
      gateway_reference: attempt.gatewayReference,
      replayed: attempt.replayed,
      delay_before_ms: attempt.delayBeforeMs,
      duration_ms: attempt.durationMs,
      created_at: attempt.createdAt,
    })),
    created_at: payment.createdAt,
  };
}
