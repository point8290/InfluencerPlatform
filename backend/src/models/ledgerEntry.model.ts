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
import type { Payment } from './payment.model';
import type { Campaign } from './campaign.model';

export type LedgerReason = 'purchase' | 'campaign_funding';

/**
 * One movement of credits. Append-only, signed, and the source of truth —
 * for any currency, SUM(delta) equals that currency's balance.
 *
 * The class is LedgerEntry (one row) while the table is `ledger` (the whole
 * book). tableName is pinned explicitly so Sequelize's pluralization never gets
 * a say, and so migrations, models and hand-typed SQL all agree on one name.
 *
 * There is no updatedAt: rows are never modified, and a column implying
 * otherwise would misdescribe the table. `timestamps` therefore keeps only
 * createdAt.
 *
 * The two nullable references carry the exactly-once guarantees:
 *   paymentId  — UNIQUE, so a payment can grant credits at most once
 *   campaignId — UNIQUE, so a campaign can be funded at most once
 * Purchase rows set paymentId and leave campaignId NULL, and vice versa; MySQL
 * permits many NULLs in a unique index, which is what lets both coexist.
 */
export class LedgerEntry extends Model<
  InferAttributes<LedgerEntry>,
  InferCreationAttributes<LedgerEntry>
> {
  declare id: CreationOptional<number>;
  declare walletId: ForeignKey<Wallet['id']>;
  declare currencyId: ForeignKey<Currency['id']>;
  /** Signed: positive on purchase, negative on spend. Never zero. */
  declare delta: number;
  declare reason: LedgerReason;
  declare paymentId: CreationOptional<ForeignKey<Payment['id']> | null>;
  declare campaignId: CreationOptional<ForeignKey<Campaign['id']> | null>;
  declare createdAt: CreationOptional<Date>;

  declare wallet?: NonAttribute<Wallet>;
  declare currency?: NonAttribute<Currency>;
  declare payment?: NonAttribute<Payment>;
  declare campaign?: NonAttribute<Campaign>;
}

LedgerEntry.init(
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
    delta: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    reason: {
      type: DataTypes.ENUM('purchase', 'campaign_funding'),
      allowNull: false,
    },
    paymentId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    campaignId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'ledger',
    modelName: 'LedgerEntry',
    // Append-only: created once, never updated.
    updatedAt: false,
  },
);
