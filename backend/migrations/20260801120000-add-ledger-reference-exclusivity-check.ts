import { QueryTypes, type QueryInterface } from 'sequelize';

/**
 * Makes the ledger's exclusive arc an actual database guarantee.
 *
 * `payment_id` and `campaign_id` are two nullable FKs of which exactly one is
 * meant to be populated — the populated one says what kind of movement the row
 * records. Until now that was application discipline only: a row with BOTH
 * references null, or both set, or a `reason` disagreeing with whichever column
 * was filled, inserted without complaint. (Confirmed during schema validation —
 * a row with both references null was accepted.)
 *
 * No correctness guarantee depended on it. `uq_ledger_payment_id` and
 * `uq_ledger_campaign_id` hold independently, so exactly-once-per-payment and
 * at-most-once-per-campaign were never at risk. What was unprotected is
 * coherence, and since the ledger is append-only and is the source of truth for
 * every balance, an incoherent row is permanent.
 *
 * WHY THIS ALSO REWRITES THE TWO FOREIGN KEYS
 *
 * MySQL refuses to create a CHECK over a column that carries foreign-key
 * referential actions:
 *
 *   ERROR 3823: Column 'payment_id' cannot be used in a check constraint
 *   ... needed in a foreign key constraint ... referential action.
 *
 * The original FKs declared `ON DELETE RESTRICT ON UPDATE CASCADE`. Both are
 * removable at no cost, which was verified rather than assumed:
 *
 *   - ON DELETE RESTRICT is InnoDB's DEFAULT. Dropping the explicit clause
 *     keeps the behaviour — deleting a referenced payment or campaign still
 *     fails with errno 1451. The protection that matters is retained.
 *   - ON UPDATE CASCADE is dead weight: these reference AUTO_INCREMENT primary
 *     keys, which are never updated, so the action could never fire.
 *
 * The FKs are also given explicit names on the way through, replacing the
 * auto-generated `ledger_ibfk_3` / `ledger_ibfk_4`, so a violation names the
 * relationship rather than a position.
 *
 * Deliberately NOT constrained: the sign of `delta` against `reason`. Reversing
 * a grant would mean a compensating negative row on the purchase side, and
 * tying sign to reason now would foreclose that while buying nothing —
 * `chk_ledger_delta_non_zero` already rejects the genuinely meaningless case.
 *
 * Added as a separate migration rather than folded into the ledger migration,
 * which has already run: editing an applied migration silently diverges any
 * database that ran the earlier version.
 */
const CHECK_NAME = 'chk_ledger_reference_exclusive';

const EXCLUSIVITY_CHECK = `
  (\`reason\` = 'purchase'         AND \`payment_id\`  IS NOT NULL AND \`campaign_id\` IS NULL)
  OR
  (\`reason\` = 'campaign_funding' AND \`campaign_id\` IS NOT NULL AND \`payment_id\`  IS NULL)
`;

/** Current FK constraint names for the two reference columns, whatever they are called. */
async function referenceForeignKeys(queryInterface: QueryInterface): Promise<string[]> {
  const rows = await queryInterface.sequelize.query<{ name: string }>(
    `SELECT DISTINCT CONSTRAINT_NAME AS name
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ledger'
        AND REFERENCED_TABLE_NAME IS NOT NULL
        AND COLUMN_NAME IN ('payment_id', 'campaign_id')`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((row) => row.name);
}

export async function up(queryInterface: QueryInterface): Promise<void> {
  for (const name of await referenceForeignKeys(queryInterface)) {
    await queryInterface.sequelize.query(`ALTER TABLE \`ledger\` DROP FOREIGN KEY \`${name}\``);
  }

  // Re-added without referential actions. Deletion of a referenced row is still
  // rejected — that is InnoDB's default, not something the clause was providing.
  await queryInterface.sequelize.query(
    'ALTER TABLE `ledger` ADD CONSTRAINT `fk_ledger_payment` ' +
      'FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`)',
  );
  await queryInterface.sequelize.query(
    'ALTER TABLE `ledger` ADD CONSTRAINT `fk_ledger_campaign` ' +
      'FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`)',
  );

  // Fails loudly if any existing row already violates it, which is correct — it
  // would mean the invariant was already broken before it was enforced.
  await queryInterface.sequelize.query(
    `ALTER TABLE \`ledger\` ADD CONSTRAINT \`${CHECK_NAME}\` CHECK (${EXCLUSIVITY_CHECK})`,
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`ALTER TABLE \`ledger\` DROP CHECK \`${CHECK_NAME}\``);

  for (const name of await referenceForeignKeys(queryInterface)) {
    await queryInterface.sequelize.query(`ALTER TABLE \`ledger\` DROP FOREIGN KEY \`${name}\``);
  }

  // Restore the original declarations, so the down migration genuinely reverses
  // this one rather than approximating it.
  await queryInterface.sequelize.query(
    'ALTER TABLE `ledger` ADD CONSTRAINT `fk_ledger_payment` ' +
      'FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ' +
      'ON DELETE RESTRICT ON UPDATE CASCADE',
  );
  await queryInterface.sequelize.query(
    'ALTER TABLE `ledger` ADD CONSTRAINT `fk_ledger_campaign` ' +
      'FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ' +
      'ON DELETE RESTRICT ON UPDATE CASCADE',
  );
}
