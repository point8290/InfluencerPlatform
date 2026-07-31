import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../config/database';
import type { Currency } from './currency.model';

/**
 * A platform module — Campaigns, Reports, Discovery. Seeded configuration.
 *
 * Attributes are camelCase in TypeScript and snake_case in MySQL; the mapping
 * is handled by `underscored: true` in config/database.ts.
 *
 * The migrations own the schema. These definitions describe it so Sequelize can
 * read and write it — they never create it, because sync() is never called.
 */
export class Module extends Model<InferAttributes<Module>, InferCreationAttributes<Module>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  // Populated only when explicitly included in a query.
  declare currency?: NonAttribute<Currency>;
}

Module.init(
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'modules',
    modelName: 'Module',
  },
);
