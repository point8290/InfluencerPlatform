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
import type { Currency } from './currency.model';

/**
 * A bundle plan — "100 credits for Rs 300".
 *
 * pricePaise is stored rather than derived from the currency's per-credit rate,
 * because bundles are discounted: 1,000 Campaign Credits is Rs 2,700, not
 * Rs 3,000. Computing it would silently overcharge every bundle purchase.
 */
export class Plan extends Model<InferAttributes<Plan>, InferCreationAttributes<Plan>> {
  declare id: CreationOptional<number>;
  declare currencyId: ForeignKey<Currency['id']>;
  declare credits: number;
  /** Integer paise for the whole bundle. */
  declare pricePaise: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare currency?: NonAttribute<Currency>;
}

Plan.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    currencyId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    credits: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    pricePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'plans',
    modelName: 'Plan',
  },
);
