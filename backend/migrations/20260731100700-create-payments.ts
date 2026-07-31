import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * A purchase of credits through Stripe.
 *
 * The row is inserted BEFORE the Stripe Checkout Session is created — the local
 * record always precedes the money-moving object. If it were the other way
 * round, a failed insert would leave a paid session with nothing to account for
 * it, and the webhook contract (200 on a genuinely unknown payment, so Stripe
 * stops retrying) would turn that into permanent silent loss.
 *
 * Both Stripe id columns are therefore NULLABLE-unique:
 *   - the row legitimately predates both ids, so NULL must be allowed;
 *   - unique so one Stripe object can never attach to two payment rows;
 *   - MySQL permits many NULLs in a unique index, which makes both true at once.
 *
 * The durable identity is `payments.id`, stamped onto the session as
 * metadata.payment_id. stripe_session_id is a convenience index that gets
 * backfilled, and healed by the webhook's tier-2 lookup if that backfill failed
 * or simply had not committed yet.
 *
 * amount_paise and credits are computed server-side and FROZEN here. A plan's
 * price may be edited in configuration later; a historical purchase must still
 * read back at the price actually charged.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('payments', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    currency_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'currencies', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    // Provenance, not pricing: which configured bundle produced this purchase.
    // NULL for per-credit quantity buys, which have no bundle behind them.
    plan_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'plans', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    purchase_kind: {
      type: DataTypes.ENUM('plan', 'quantity'),
      allowNull: false,
    },
    stripe_session_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    stripe_payment_intent_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    amount_paise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    credits: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'expired', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
    },
  });

  await queryInterface.addConstraint('payments', {
    fields: ['stripe_session_id'],
    type: 'unique',
    name: 'uq_payments_stripe_session_id',
  });

  await queryInterface.addConstraint('payments', {
    fields: ['stripe_payment_intent_id'],
    type: 'unique',
    name: 'uq_payments_stripe_payment_intent_id',
  });

  await queryInterface.addIndex('payments', ['user_id'], {
    name: 'idx_payments_user_id',
  });

  await queryInterface.sequelize.query(
    'ALTER TABLE `payments` ADD CONSTRAINT `chk_payments_amounts_positive` ' +
      'CHECK (`amount_paise` > 0 AND `credits` > 0)',
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('payments');
}
