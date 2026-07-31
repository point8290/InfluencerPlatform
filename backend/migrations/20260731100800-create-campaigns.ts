import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * Campaigns.
 *
 * module_id is set by the server, never chosen by the client, because choosing
 * a module is choosing a currency: funding resolves campaign.module_id ->
 * currencies.module_id -> the currency that may be spent. That resolution is
 * the whole currency-isolation guarantee, and it would be defeated if the
 * caller could pick the module.
 *
 * status is a one-way draft -> funded transition taken under a row lock. It is
 * the readable half of fund-at-most-once; UNIQUE(ledger.campaign_id) is the
 * structural half beneath it.
 *
 * The funded amount is deliberately NOT stored here — it is derived from the
 * single ledger row that references this campaign. The ledger is the source of
 * truth for credit movement, and a copy on this table would be a second place
 * to be wrong.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('campaigns', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    module_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'modules', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    // Display only. Nothing in the funding path reads it.
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('draft', 'funded'),
      allowNull: false,
      defaultValue: 'draft',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
    },
  });

  await queryInterface.addIndex('campaigns', ['user_id'], {
    name: 'idx_campaigns_user_id',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('campaigns');
}
