import type { Transaction } from 'sequelize';
import { Balance, LedgerEntry, Payment, Wallet } from '../../models';

/**
 * Credits a paid purchase to its owner's wallet and marks the payment paid.
 *
 * Shared by every flow that can learn a payment succeeded — the Stripe Checkout
 * webhook and the server-driven direct flow — so there is one grant, not two
 * that could drift apart.
 *
 * The CALLER owns the transaction and must already hold the payment row FOR
 * UPDATE and have checked it is 'pending'. Exactly-once does not rest on that
 * check, though: the ledger insert below dies on UNIQUE(ledger.payment_id) if a
 * grant for this payment already exists, and callers map that violation to
 * "already granted".
 */
export async function applyPurchaseGrant(payment: Payment, transaction: Transaction): Promise<void> {
  const wallet = await Wallet.findOne({ where: { userId: payment.userId }, transaction });
  if (wallet === null) {
    // Signup creates the wallet in the same transaction as the user, so this
    // is unreachable. Throwing gives a 500 (and, for a webhook, a redelivery)
    // rather than silently swallowing a broken invariant.
    throw new Error(`Payment ${payment.id} belongs to user ${payment.userId}, who has no wallet.`);
  }

  // THE structural guarantee. A concurrent duplicate that gets past the
  // caller's status check dies here, on the unique index.
  await LedgerEntry.create(
    {
      walletId: wallet.id,
      currencyId: payment.currencyId,
      delta: payment.credits,
      reason: 'purchase',
      paymentId: payment.id,
    },
    { transaction },
  );

  // Atomic SQL increment (balance = balance + n), not read-then-write, so
  // concurrent grants to the same balance cannot lose an update. The spend
  // path locks this row explicitly instead, because it must READ the value
  // to check sufficiency — a grant only ever adds.
  await Balance.increment(
    { balance: payment.credits },
    { where: { walletId: wallet.id, currencyId: payment.currencyId }, transaction },
  );

  await payment.update({ status: 'paid' }, { transaction });
}
