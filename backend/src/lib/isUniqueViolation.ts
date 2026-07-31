import { UniqueConstraintError } from 'sequelize';

/**
 * True when an error is MySQL rejecting a duplicate on a unique index.
 *
 * This is how the design's structural guarantees are read back in application
 * code. Several flows deliberately race the database and treat losing as a
 * normal outcome rather than a failure:
 *
 *   - a duplicate Stripe webhook loses uq_ledger_payment_id  -> already granted
 *   - a second funding request loses uq_ledger_campaign_id   -> already funded
 *   - a concurrent signup loses uq_users_email               -> already taken
 *
 * In each case the application-level pre-check is a fast path, and this is how
 * we recognise that the index — the actual guarantee — did the work.
 *
 * Pass `constraintName` to distinguish which promise was kept: a single
 * statement can violate more than one unique index, and "already granted" and
 * "already funded" need different responses.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (!(error instanceof UniqueConstraintError)) return false;
  if (constraintName === undefined) return true;

  // MySQL reports: Duplicate entry 'x' for key 'ledger.uq_ledger_payment_id'.
  // Sequelize keeps the driver error on `parent`, and only that message names
  // the index — the wrapper's own fields do not.
  const parent = error.parent as { sqlMessage?: string } | undefined;
  const message = parent?.sqlMessage ?? error.message;

  return message.includes(constraintName);
}
