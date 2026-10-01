import { DataTypes, type QueryInterface } from 'sequelize';

/**
 * A platform role per user, carried in the access token as the `role` claim
 * and enforced by the analytics service's RBAC.
 *
 *   member   — sees analytics for their own wallet and campaigns only
 *   analyst  — platform-wide aggregates; PII masked, no money amounts
 *   finance  — analyst + revenue (amounts in paise); PII masked
 *   admin    — everything, including unmasked PII and governance metadata
 *
 * Every existing and new user is a `member`. Elevation is an operator action
 * (`npm run user:set-role`), never something the API lets a user request.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.addColumn('users', 'role', {
    type: DataTypes.ENUM('member', 'analyst', 'finance', 'admin'),
    allowNull: false,
    defaultValue: 'member',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.removeColumn('users', 'role');
}
