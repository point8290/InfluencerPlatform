import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * The three credit currencies, each bound to exactly one module.
 *
 * UNIQUE(module_id) is the load-bearing constraint here: it makes the
 * currency<->module relationship 1:1 at the schema level. Spending resolves
 * campaign.module_id -> this row, so "a campaign can only be funded with
 * Campaign Credits" is a structural fact rather than an `if` in business logic,
 * and Reports/Discovery spending can later be added by the same pattern.
 *
 * price_paise_per_credit is stored, so adding a currency is a data change.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('currencies', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    module_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'modules', key: 'id' },
      onUpdate: 'CASCADE',
      // Configuration rows are never deleted at runtime. RESTRICT makes an
      // accidental deletion fail loudly instead of cascading into user data.
      onDelete: 'RESTRICT',
    },
    price_paise_per_credit: {
      type: DataTypes.INTEGER,
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

  await queryInterface.addConstraint('currencies', {
    fields: ['code'],
    type: 'unique',
    name: 'uq_currencies_code',
  });

  // THE currency<->module binding. One currency per module, forever.
  await queryInterface.addConstraint('currencies', {
    fields: ['module_id'],
    type: 'unique',
    name: 'uq_currencies_module_id',
  });

  // Written as raw SQL rather than through Sequelize's operator objects: this
  // is exactly the text that appears in SHOW CREATE TABLE, with nothing to
  // translate in your head when reading it back.
  await queryInterface.sequelize.query(
    'ALTER TABLE `currencies` ADD CONSTRAINT `chk_currencies_price_positive` ' +
      'CHECK (`price_paise_per_credit` > 0)',
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('currencies');
}
