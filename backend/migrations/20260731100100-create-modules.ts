import { DataTypes, literal, type QueryInterface } from "sequelize";

/**
 * Platform modules — Campaigns, Reports, Discovery.
 *
 * Seeded configuration, not runtime data. A module is one half of the
 * currency<->module binding: each module has exactly one currency that may be
 * spent in it, enforced by UNIQUE(currencies.module_id) in the next migration.
 *
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable("modules", {
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
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal("CURRENT_TIMESTAMP"),
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
    },
  });

  await queryInterface.addConstraint("modules", {
    fields: ["code"],
    type: "unique",
    name: "uq_modules_code",
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable("modules");
}
