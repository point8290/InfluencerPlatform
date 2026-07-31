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
import type { Module } from './module.model';
import type { Plan } from './plan.model';

/**
 * A credit currency, bound 1:1 to a module by UNIQUE(module_id).
 *
 * That binding is how currency isolation works: funding resolves
 * campaign.moduleId -> this row, so the spend currency is never supplied by the
 * caller. Adding Reports or Discovery spending later follows the same path
 * rather than requiring new business logic.
 */
export class Currency extends Model<
  InferAttributes<Currency>,
  InferCreationAttributes<Currency>
> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare moduleId: ForeignKey<Module['id']>;
  /** Integer paise. Rs 3 per credit is 300. */
  declare pricePaisePerCredit: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare module?: NonAttribute<Module>;
  declare plans?: NonAttribute<Plan[]>;
}

Currency.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    code: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    moduleId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    pricePaisePerCredit: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'currencies',
    modelName: 'Currency',
  },
);
