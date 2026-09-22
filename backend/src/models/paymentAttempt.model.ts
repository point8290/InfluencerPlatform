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
import type { Payment } from './payment.model';

export type AttemptTrigger = 'initial' | 'retry' | 'reconcile';

export type AttemptOutcome =
  | 'in_flight'
  | 'succeeded'
  | 'requires_action'
  | 'declined'
  | 'transient_error'
  | 'unknown';

/**
 * One call from this server to the payment gateway for a direct payment.
 *
 * Calls sharing an `attemptNumber` share an `idempotencyKey`: they are re-sends
 * of one logical charge after a transient failure, and the gateway executes at
 * most one of them. A new attempt number means a new key — a genuinely new
 * charge attempt, made only after the previous one definitely failed.
 */
export class PaymentAttempt extends Model<
  InferAttributes<PaymentAttempt>,
  InferCreationAttributes<PaymentAttempt>
> {
  declare id: CreationOptional<number>;
  declare paymentId: ForeignKey<Payment['id']>;
  declare callNumber: number;
  declare attemptNumber: number;
  declare idempotencyKey: string;
  declare trigger: AttemptTrigger;
  declare outcome: CreationOptional<AttemptOutcome>;
  declare errorCode: CreationOptional<string | null>;
  declare errorMessage: CreationOptional<string | null>;
  declare gatewayReference: CreationOptional<string | null>;
  declare replayed: CreationOptional<boolean>;
  declare delayBeforeMs: CreationOptional<number>;
  declare durationMs: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare payment?: NonAttribute<Payment>;
}

PaymentAttempt.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    paymentId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    callNumber: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    attemptNumber: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    idempotencyKey: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    trigger: {
      type: DataTypes.ENUM('initial', 'retry', 'reconcile'),
      allowNull: false,
    },
    outcome: {
      type: DataTypes.ENUM(
        'in_flight',
        'succeeded',
        'requires_action',
        'declined',
        'transient_error',
        'unknown',
      ),
      allowNull: false,
      defaultValue: 'in_flight',
    },
    errorCode: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    errorMessage: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    gatewayReference: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    replayed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    delayBeforeMs: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    durationMs: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'payment_attempts',
    modelName: 'PaymentAttempt',
  },
);
