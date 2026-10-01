import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../config/database';

/**
 * A domain event awaiting publication to Kafka. Written in the same transaction
 * as the change it describes; see the create-outbox-events migration for why.
 *
 * Rows are never deleted by the application. `published_at` marks delivery to
 * the broker, which is what the relay's scan keys on.
 */
export class OutboxEvent extends Model<
  InferAttributes<OutboxEvent>,
  InferCreationAttributes<OutboxEvent>
> {
  declare id: CreationOptional<number>;
  declare eventId: string;
  declare topic: string;
  declare eventType: string;
  declare aggregateType: string;
  declare aggregateId: string;
  declare payload: Record<string, unknown>;
  declare occurredAt: Date;
  declare publishedAt: CreationOptional<Date | null>;
  declare attempts: CreationOptional<number>;
  declare lastError: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

OutboxEvent.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    eventId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    topic: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    eventType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    aggregateType: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    aggregateId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    occurredAt: {
      type: DataTypes.DATE(3),
      allowNull: false,
    },
    publishedAt: {
      type: DataTypes.DATE(3),
      allowNull: true,
    },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lastError: {
      type: DataTypes.STRING(1024),
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'outbox_events',
    modelName: 'OutboxEvent',
    updatedAt: false,
  },
);
