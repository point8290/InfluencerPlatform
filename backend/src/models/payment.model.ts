import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../config/database';
import type { User } from './user.model';
import type { Currency } from './currency.model';
import type { Plan } from './plan.model';
import type { PaymentAttempt } from './paymentAttempt.model';

export type PurchaseKind = 'plan' | 'quantity';
export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'failed';

/** What a direct payment asked for; see the payment_attempts migration. */
export interface DirectPaymentOptions {
  paymentMethod: string;
  maxRetries: number;
  simulatedFailures: number;
  /**
   * Random per payment, and part of every gateway idempotency key. Payment ids
   * repeat when a development database is reset, but a gateway remembers keys
   * for a day — without this, a reused id could be answered with a different
   * payment's stored result.
   */
  keyNonce: string;
}

/** Which flow owns the row: hosted Checkout, or a server-driven direct charge. */
export type PaymentChannel = 'checkout' | 'direct';

/**
 * A credit purchase through Stripe.
 *
 * The row is created BEFORE the Stripe Checkout Session exists, so both Stripe
 * ids start NULL and are backfilled. The durable identity is `id`, stamped onto
 * the session as metadata.payment_id; `stripeSessionId` is a lookup index the
 * webhook heals if it is missing or has not committed yet.
 *
 * `amountPaise` and `credits` are computed server-side and frozen at creation.
 * A plan's configured price may change later; this purchase must still read
 * back at the price actually charged.
 *
 * Pairing invariant, enforced in the service layer rather than by a CHECK:
 *   purchaseKind 'plan'     => planId is set
 *   purchaseKind 'quantity' => planId is NULL
 */
export class Payment extends Model<InferAttributes<Payment>, InferCreationAttributes<Payment>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User['id']>;
  declare currencyId: ForeignKey<Currency['id']>;
  declare planId: CreationOptional<ForeignKey<Plan['id']> | null>;
  declare purchaseKind: PurchaseKind;
  declare stripeSessionId: CreationOptional<string | null>;
  declare stripePaymentIntentId: CreationOptional<string | null>;

  /**
   * Client-supplied, unique per user. Present only when the caller asked for
   * idempotency; NULL requests behave as they always did.
   */
  declare idempotencyKey: CreationOptional<string | null>;

  /**
   * Stored so an idempotent replay can be served without calling Stripe — the
   * replay path must not depend on the service whose slowness caused the retry.
   */
  declare checkoutUrl: CreationOptional<string | null>;
  declare amountPaise: number;
  declare credits: number;
  declare channel: CreationOptional<PaymentChannel>;
  declare directOptions: CreationOptional<DirectPaymentOptions | null>;

  /**
   * Direct payments only: set while one request owns the right to call the
   * gateway for this row. See the payment_attempts migration.
   */
  declare processingStartedAt: CreationOptional<Date | null>;
  declare status: CreationOptional<PaymentStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;
  declare currency?: NonAttribute<Currency>;
  declare plan?: NonAttribute<Plan>;
  declare attempts?: NonAttribute<PaymentAttempt[]>;
}

Payment.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    currencyId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    planId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    purchaseKind: {
      type: DataTypes.ENUM('plan', 'quantity'),
      allowNull: false,
    },
    stripeSessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    idempotencyKey: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    checkoutUrl: {
      type: DataTypes.STRING(2048),
      allowNull: true,
    },
    stripePaymentIntentId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    amountPaise: {
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
    channel: {
      type: DataTypes.ENUM('checkout', 'direct'),
      allowNull: false,
      defaultValue: 'checkout',
    },
    directOptions: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    processingStartedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'payments',
    modelName: 'Payment',
  },
);
