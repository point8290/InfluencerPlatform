/**
 * Changes a user's platform role: `npm run user:set-role -- <email> <role>`.
 *
 * Roles gate the analytics service (see analytics/README.md → RBAC). There is
 * deliberately no HTTP endpoint for this — privilege elevation is an operator
 * action against the database, and it is recorded as a `user.role_changed`
 * event so the change is auditable in the warehouse.
 */
import { USER_ROLES, User, sequelize, type UserRole } from '../src/models';
import { recordEvent } from '../src/outbox/recordEvent';

async function main(): Promise<void> {
  const [email, role] = process.argv.slice(2);

  if (email === undefined || role === undefined || !(USER_ROLES as readonly string[]).includes(role)) {
    console.error(`Usage: npm run user:set-role -- <email> <${USER_ROLES.join('|')}>`);
    process.exitCode = 1;
    return;
  }

  const outcome = await sequelize.transaction(async (transaction) => {
    const user = await User.findOne({
      where: { email: email.trim().toLowerCase() },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (user === null) return `No user with email ${email}.`;

    const previousRole = user.role;
    if (previousRole === role) return `${user.email} is already ${role}.`;

    await user.update({ role: role as UserRole }, { transaction });
    await recordEvent(transaction, 'user.role_changed', {
      user_id: user.id,
      previous_role: previousRole,
      role: role as UserRole,
    });
    return `${user.email}: ${previousRole} -> ${role}. Takes effect at their next login.`;
  });

  console.log(outcome);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
