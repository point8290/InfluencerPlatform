import { DataTypes, literal, type QueryInterface } from 'sequelize';

/**
 * Server-driven ("direct") payments and the log of every gateway call they make.
 *
 * In the Checkout flow the browser talks to Stripe and this server only hears
 * the result. In the direct flow THIS SERVER calls the gateway to charge, which
 * is what makes a server-side retry possible at all — and what makes it
 * dangerous, because a retry after an ambiguous failure can charge twice.
 *
 * payments.channel
 *   Which flow owns the row. The existing Checkout rows default to 'checkout',
 *   so nothing about them changes. Both flows share the payments table on
 *   purpose: the grant is keyed on payments.id and guarded by
 *   uq_ledger_payment_id, so exactly-once crediting is inherited, not rebuilt.
 *
 * payments.direct_options
 *   What the direct request asked for — payment method, retry budget and, for
 *   the simulated gateway, how many failures to inject. Stored because a
 *   reconciliation must re-send a charge with EXACTLY the original parameters:
 *   a gateway rejects an idempotency key reused with different ones.
 *
 * payments.processing_started_at
 *   A claim, not a lock. A request that wants to call the gateway for a payment
 *   must first flip this from NULL (or stale) to NOW() in one UPDATE; only the
 *   request whose UPDATE matched a row may proceed. Holding a database
 *   transaction open across a slow network call would pin a connection and a
 *   row lock for seconds — the claim gives the same mutual exclusion without it.
 *
 * payment_attempts
 *   One row per gateway CALL. `attempt_number` groups calls that share an
 *   idempotency key: a transient failure is re-sent under the same key (same
 *   attempt, higher call_number); a retryable decline starts a new attempt with
 *   a new key. UNIQUE(payment_id, call_number) keeps the log strictly ordered.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.addColumn('payments', 'channel', {
    type: DataTypes.ENUM('checkout', 'direct'),
    allowNull: false,
    defaultValue: 'checkout',
  });

  await queryInterface.addColumn('payments', 'direct_options', {
    type: DataTypes.JSON,
    allowNull: true,
  });

  await queryInterface.addColumn('payments', 'processing_started_at', {
    type: DataTypes.DATE,
    allowNull: true,
  });

  await queryInterface.createTable('payment_attempts', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    payment_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'payments', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    call_number: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    attempt_number: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    idempotency_key: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Why this call happened: the first call, an automatic retry, or a
    // reconciliation that re-sent an attempt whose outcome was unknown.
    trigger: {
      type: DataTypes.ENUM('initial', 'retry', 'reconcile'),
      allowNull: false,
    },
    // in_flight until the gateway answers. A row left in_flight means the
    // process died mid-call — exactly the "unknown outcome" case.
    outcome: {
      type: DataTypes.ENUM(
        'in_flight',
        'succeeded',
        'requires_action',
        'declined',
        'transient_error',
        'unknown',
      ),
      allowNull: false,
      defaultValue: 'in_flight',
    },
    error_code: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    error_message: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    // The gateway's own id for the charge (pi_… for Stripe), when it gave one.
    gateway_reference: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // True when the gateway answered from its idempotency cache rather than
    // executing — the proof that a retry did NOT charge a second time.
    replayed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    delay_before_ms: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    duration_ms: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
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

  await queryInterface.addConstraint('payment_attempts', {
    fields: ['payment_id', 'call_number'],
    type: 'unique',
    name: 'uq_payment_attempts_payment_call',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('payment_attempts');
  await queryInterface.removeColumn('payments', 'processing_started_at');
  await queryInterface.removeColumn('payments', 'direct_options');
  await queryInterface.removeColumn('payments', 'channel');
}
