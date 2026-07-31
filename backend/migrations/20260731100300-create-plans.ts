import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * Bundle plans — "100 credits for Rs 300", "1,000 credits for Rs 2,700".
 *
 * price_paise is STORED rather than computed as credits * price_per_credit,
 * because bundles are discounted: 1,000 Campaign Credits costs Rs 2,700, not
 * Rs 3,000. Deriving it would silently overcharge for every bundle.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('plans', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    currency_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'currencies', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    credits: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    price_paise: {
      type: DataTypes.BIGINT,
      allowNull: false,
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

  await queryInterface.addIndex('plans', ['currency_id'], {
    name: 'idx_plans_currency_id',
  });

  // A zero-or-negative bundle would produce a zero-or-negative Stripe charge.
  await queryInterface.sequelize.query(
    'ALTER TABLE `plans` ADD CONSTRAINT `chk_plans_amounts_positive` ' +
      'CHECK (`credits` > 0 AND `price_paise` > 0)',
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('plans');
}
