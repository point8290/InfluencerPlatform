import { DataTypes, literal, type QueryInterface } from "sequelize";

/**
 * The ledger — append-only, signed, and the source of truth for every credit
 * movement. For any currency, the sum of `delta` equals that currency's
 * balance; the `balances` table is a projection maintained in the same
 * transaction, never an independent record.
 *
 * TWO STRUCTURAL GUARANTEES live here, both relying on MySQL permitting many
 * NULLs inside a unique index:
 *
 *   uq_ledger_payment_id   -> credits are granted AT MOST ONCE per payment.
 *                             A duplicate webhook that gets past the
 *                             application's status check still cannot insert a
 *                             second grant row. This, not the status check, is
 *                             the exactly-once guarantee.
 *
 *   uq_ledger_campaign_id  -> a campaign is funded AT MOST ONCE.
 *
 * Purchase rows carry payment_id and leave campaign_id NULL; funding rows do
 * the reverse.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable("ledger", {
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
    // Signed: positive for a purchase, negative for a spend.
    delta: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    reason: {
      type: DataTypes.ENUM("purchase", "campaign_funding"),
      allowNull: false,
    },
    // Set on purchase rows only. RESTRICT: a payment that has granted credits
    // must not be deletable out from under the ledger row accounting for it.
    payment_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: "payments", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    },
    // Set on funding rows only.
    campaign_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: "campaigns", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal("CURRENT_TIMESTAMP"),
    },
  });

  // Exactly-once grant per payment.
  await queryInterface.addConstraint("ledger", {
    fields: ["payment_id"],
    type: "unique",
    name: "uq_ledger_payment_id",
  });

  // Fund a campaign at most once.
  await queryInterface.addConstraint("ledger", {
    fields: ["campaign_id"],
    type: "unique",
    name: "uq_ledger_campaign_id",
  });

  // Serves the ledger history endpoint, which reads one wallet's entries for
  // one currency, newest first.
  await queryInterface.addIndex("ledger", ["wallet_id", "currency_id", "id"], {
    name: "idx_ledger_wallet_currency_id",
  });

  // A zero-delta entry would be a movement that moved nothing, and would break
  // the "balance equals the sum of the ledger" reading by adding noise rows.
  await queryInterface.sequelize.query(
    "ALTER TABLE `ledger` ADD CONSTRAINT `chk_ledger_delta_non_zero` " +
      "CHECK (`delta` <> 0)",
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable("ledger");
}
