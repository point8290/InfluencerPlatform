import { DataTypes, type QueryInterface } from 'sequelize';

/**
 * Makes checkout-session creation idempotent.
 *
 * Without this, a retried POST — a double click, a timed-out request the client
 * resends, a proxy retry — creates a second `payments` row and a second LIVE
 * Stripe session. No credits can be fabricated (the grant is keyed on
 * payments.id and guarded by uq_ledger_payment_id), but both sessions are
 * payable, so a user with two tabs open can be charged twice for one intent.
 *
 * The key is client-supplied, exactly as Stripe's own `Idempotency-Key` header
 * works. It cannot be derived server-side from the request body: buying 100
 * credits twice on purpose is two legitimate intents, and hashing the payload
 * would silently collapse them into one.
 *
 * SCOPED PER USER, DELIBERATELY.
 *
 * `UNIQUE(user_id, idempotency_key)` rather than `UNIQUE(idempotency_key)`.
 * A global key space would be a security defect: one user could claim a key
 * value another user later sends, and the second user's request would then
 * either be denied or — far worse — be answered with the FIRST user's payment
 * and checkout URL. Scoping by user makes a collision impossible to weaponise,
 * and every lookup filters on user_id as well as the key.
 *
 * `checkout_url` is stored rather than re-fetched from Stripe on replay. The
 * replay path exists to absorb failures, and the most likely reason a client is
 * retrying is that Stripe was slow or unreachable — so serving the replay from
 * Stripe would reintroduce the very dependency it is meant to survive. The URL
 * is immutable for the session's lifetime; once the session expires Stripe's
 * own page says so, which degrades better than a null.
 *
 * Both columns are nullable: requests without a key keep working exactly as
 * before, and MySQL allows many rows where part of a unique tuple is NULL.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.addColumn('payments', 'idempotency_key', {
    type: DataTypes.STRING(255),
    allowNull: true,
  });

  await queryInterface.addColumn('payments', 'checkout_url', {
    type: DataTypes.STRING(2048),
    allowNull: true,
  });

  await queryInterface.addConstraint('payments', {
    fields: ['user_id', 'idempotency_key'],
    type: 'unique',
    name: 'uq_payments_user_idempotency_key',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.removeConstraint('payments', 'uq_payments_user_idempotency_key');
  await queryInterface.removeColumn('payments', 'checkout_url');
  await queryInterface.removeColumn('payments', 'idempotency_key');
}
