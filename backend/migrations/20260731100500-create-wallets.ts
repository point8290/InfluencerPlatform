import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * One wallet per user, enforced by UNIQUE(user_id).
 *
 * The wallet itself holds no money — it is the owner of the per-currency
 * `balances` rows and of the `ledger` entries. Keeping it as its own table
 * rather than hanging balances directly off `users` means a later change (a
 * shared team wallet, say) does not require re-parenting every balance and
 * ledger row.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('wallets', {
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
      // Deleting a user takes their wallet with it. Unlike configuration
      // tables, this is genuinely owned data.
      onDelete: 'CASCADE',
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

  await queryInterface.addConstraint('wallets', {
    fields: ['user_id'],
    type: 'unique',
    name: 'uq_wallets_user_id',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('wallets');
}
