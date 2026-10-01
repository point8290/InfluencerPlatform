import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../config/database';
import type { Wallet } from './wallet.model';

/**
 * Platform roles, enforced by the analytics service's RBAC. The order of this
 * tuple is the column's ENUM order in the migration; keep the two in step.
 */
export const USER_ROLES = ['member', 'analyst', 'finance', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * A user. Only the bcrypt hash of the password is ever stored.
 */
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare passwordHash: string;
  declare role: CreationOptional<UserRole>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare wallet?: NonAttribute<Wallet>;
}

User.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM(...USER_ROLES),
      allowNull: false,
      defaultValue: 'member',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'users',
    modelName: 'User',
    defaultScope: {
      // The hash should never leave the database by accident. Queries that
      // genuinely need it (login) opt back in with .scope('withPassword').
      attributes: { exclude: ['passwordHash'] },
    },
    scopes: {
      withPassword: {},
    },
  },
);
