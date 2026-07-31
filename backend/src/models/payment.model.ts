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

export type PurchaseKind = 'plan' | 'quantity';
export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'failed';

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
  declare amountPaise: number;
  declare credits: number;
  declare status: CreationOptional<PaymentStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;
  declare currency?: NonAttribute<Currency>;
  declare plan?: NonAttribute<Plan>;
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'payments',
    modelName: 'Payment',
  },
);
