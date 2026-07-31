import { DataTypes, literal, type QueryInterface } from "sequelize";

/**
 * Users. Passwords are stored only as a bcrypt hash — never the password, and
 * never a reversible encryption of it.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable("users", {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    password_hash: {
      type: DataTypes.STRING(255),
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

  await queryInterface.addConstraint("users", {
    fields: ["email"],
    type: "unique",
    name: "uq_users_email",
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable("users");
}
