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
import type { Wallet } from './wallet.model';
import type { Currency } from './currency.model';

/**
 * A wallet's balance in one currency — a projection of the ledger, maintained
 * in the same transaction as every ledger insert.
 *
 * This is the row that spending locks. UNIQUE(wallet_id, currency_id) in the
 * migration guarantees `SELECT ... FOR UPDATE` matches exactly one row, which
 * is what makes concurrent funding serialize rather than both read a stale
 * value. All three rows are created at signup, so no code path ever has to
 * create one lazily and race another request doing the same.
 */
export class Balance extends Model<InferAttributes<Balance>, InferCreationAttributes<Balance>> {
  declare id: CreationOptional<number>;
  declare walletId: ForeignKey<Wallet['id']>;
  declare currencyId: ForeignKey<Currency['id']>;
  /** Integer credits. Never negative — CHECK(balance >= 0) in the migration. */
  declare balance: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare wallet?: NonAttribute<Wallet>;
  declare currency?: NonAttribute<Currency>;
}

Balance.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    walletId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    currencyId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    balance: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'balances',
    modelName: 'Balance',
  },
);
