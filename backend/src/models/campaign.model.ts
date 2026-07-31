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
import type { Module } from './module.model';
import type { LedgerEntry } from './ledgerEntry.model';

export type CampaignStatus = 'draft' | 'funded';

/**
 * A campaign.
 *
 * `moduleId` is assigned by the server, never chosen by the client, because
 * choosing a module is choosing a currency — funding resolves
 * moduleId -> currencies.moduleId -> the only currency that may be spent.
 *
 * The funded amount is NOT stored here. It is read from the single ledger row
 * referencing this campaign, so there is one place for it to be right.
 */
export class Campaign extends Model<InferAttributes<Campaign>, InferCreationAttributes<Campaign>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User['id']>;
  declare moduleId: ForeignKey<Module['id']>;
  declare name: string;
  declare status: CreationOptional<CampaignStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;
  declare module?: NonAttribute<Module>;

  /**
   * At most one, guaranteed by UNIQUE(ledger.campaign_id). This is where the
   * funded amount is read from — it is deliberately not stored on this table.
   */
  declare ledgerEntry?: NonAttribute<LedgerEntry>;
}

Campaign.init(
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
    moduleId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('draft', 'funded'),
      allowNull: false,
      defaultValue: 'draft',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'campaigns',
    modelName: 'Campaign',
  },
);
