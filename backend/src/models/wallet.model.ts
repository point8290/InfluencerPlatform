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
import type { Balance } from './balance.model';
import type { LedgerEntry } from './ledgerEntry.model';

/**
 * One wallet per user. Holds no amount itself — it owns the per-currency
 * `balances` rows and the `ledger` entries.
 */
export class Wallet extends Model<InferAttributes<Wallet>, InferCreationAttributes<Wallet>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;
  declare balances?: NonAttribute<Balance[]>;
  declare ledgerEntries?: NonAttribute<LedgerEntry[]>;
}

Wallet.init(
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wallets',
    modelName: 'Wallet',
  },
);
