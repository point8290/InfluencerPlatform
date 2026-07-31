import { DataTypes, literal, type QueryInterface } from "sequelize";

/**
 * Per-currency balance for a wallet — a materialized, transactionally
 * maintained projection of the ledger, not a second source of truth.
 *
 * Two constraints do the real work:
 *
 * UNIQUE(wallet_id, currency_id) is the entire concurrency-safety mechanism
 * for spending. It guarantees that `SELECT ... FOR UPDATE` on a (wallet,
 * currency) pair locks EXACTLY ONE row, so two concurrent funding requests
 * serialize on it instead of both reading a stale balance. Without this
 * constraint a duplicate row could exist and each request could lock a
 * different one, and the lock would protect nothing.
 *
 * CHECK(balance >= 0) is the floor beneath the application's insufficient-funds
 * check. The application check produces the friendly 422; this makes a negative
 * balance impossible even if that check were bypassed or wrong.
 *
 * All three rows are created at signup, so every later grant and spend can
 * assume the row exists and is lockable — there is no lazy-create path to race.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable("balances", {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    wallet_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: "wallets", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    currency_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: "currencies", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    },
    // Signed BIGINT rather than UNSIGNED on purpose: an unsigned underflow
    // raises an out-of-range error, whereas the named CHECK below fails with a
    // constraint name that says what was actually violated.
    balance: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
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

  // Exactly one balance row per (wallet, currency).
  await queryInterface.addConstraint("balances", {
    fields: ["wallet_id", "currency_id"],
    type: "unique",
    name: "uq_balances_wallet_currency",
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE `balances` ADD CONSTRAINT `chk_balances_non_negative` " +
      "CHECK (`balance` >= 0)",
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable("balances");
}
