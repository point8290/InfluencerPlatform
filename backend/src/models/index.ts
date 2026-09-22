import { sequelize } from '../config/database';
import { Module } from './module.model';
import { Currency } from './currency.model';
import { Plan } from './plan.model';
import { User } from './user.model';
import { Wallet } from './wallet.model';
import { Balance } from './balance.model';
import { Payment } from './payment.model';
import { PaymentAttempt } from './paymentAttempt.model';
import { Campaign } from './campaign.model';
import { LedgerEntry } from './ledgerEntry.model';

/**
 * Associations live here rather than inside each model file, so that no model
 * has to import another at runtime. The model files import each other only as
 * TYPES, which TypeScript erases — that keeps the module graph acyclic no
 * matter how densely the schema is cross-referenced.
 *
 * Every association names its `foreignKey` explicitly instead of letting
 * Sequelize infer one. Inference is influenced by `underscored`, model names
 * and pluralization; naming the key means the association can only ever point
 * at the column the migration actually created.
 *
 * The `as` aliases match the declared properties on each model, so an
 * `include` returns something the type system already knows about.
 */

// Configuration: a module has exactly one currency (UNIQUE(currencies.module_id)).
Module.hasOne(Currency, { as: 'currency', foreignKey: 'moduleId' });
Currency.belongsTo(Module, { as: 'module', foreignKey: 'moduleId' });

Currency.hasMany(Plan, { as: 'plans', foreignKey: 'currencyId' });
Plan.belongsTo(Currency, { as: 'currency', foreignKey: 'currencyId' });

// Identity and wallet.
User.hasOne(Wallet, { as: 'wallet', foreignKey: 'userId' });
Wallet.belongsTo(User, { as: 'user', foreignKey: 'userId' });

Wallet.hasMany(Balance, { as: 'balances', foreignKey: 'walletId' });
Balance.belongsTo(Wallet, { as: 'wallet', foreignKey: 'walletId' });
Balance.belongsTo(Currency, { as: 'currency', foreignKey: 'currencyId' });

// Payments.
User.hasMany(Payment, { as: 'payments', foreignKey: 'userId' });
Payment.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Payment.belongsTo(Currency, { as: 'currency', foreignKey: 'currencyId' });
Payment.belongsTo(Plan, { as: 'plan', foreignKey: 'planId' });
Payment.hasMany(PaymentAttempt, { as: 'attempts', foreignKey: 'paymentId' });
PaymentAttempt.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });

// Campaigns.
User.hasMany(Campaign, { as: 'campaigns', foreignKey: 'userId' });
Campaign.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Campaign.belongsTo(Module, { as: 'module', foreignKey: 'moduleId' });

// Ledger.
Wallet.hasMany(LedgerEntry, { as: 'ledgerEntries', foreignKey: 'walletId' });
LedgerEntry.belongsTo(Wallet, { as: 'wallet', foreignKey: 'walletId' });
LedgerEntry.belongsTo(Currency, { as: 'currency', foreignKey: 'currencyId' });

// hasOne, not hasMany, on both sides: UNIQUE(ledger.payment_id) and
// UNIQUE(ledger.campaign_id) mean at most one entry can ever reference either.
// The association type states the same guarantee the index enforces.
Payment.hasOne(LedgerEntry, { as: 'ledgerEntry', foreignKey: 'paymentId' });
LedgerEntry.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });

Campaign.hasOne(LedgerEntry, { as: 'ledgerEntry', foreignKey: 'campaignId' });
LedgerEntry.belongsTo(Campaign, { as: 'campaign', foreignKey: 'campaignId' });

export {
  sequelize,
  Module,
  Currency,
  Plan,
  User,
  Wallet,
  Balance,
  Payment,
  PaymentAttempt,
  Campaign,
  LedgerEntry,
};

export type {
  PurchaseKind,
  PaymentStatus,
  PaymentChannel,
  DirectPaymentOptions,
} from './payment.model';
export type { AttemptOutcome, AttemptTrigger } from './paymentAttempt.model';
export type { CampaignStatus } from './campaign.model';
export type { LedgerReason } from './ledgerEntry.model';
