/**
 * Runs before anything imports src/config/env.ts.
 *
 * dotenv does not overwrite variables that are already set, so whatever is
 * assigned here wins over backend/.env. That is what makes the suite
 * deterministic: it uses a fixed webhook secret regardless of what a
 * developer's `stripe listen` last printed.
 *
 * It also means THE TEST SUITE NEEDS NO STRIPE ACCOUNT. Nothing here calls the
 * Stripe API — signature verification is local HMAC — so a dummy key is enough
 * and `npm test` works on a fresh clone with only MySQL running.
 */
process.env.NODE_ENV = 'test';

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_the_suite_makes_no_stripe_api_calls';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixed_secret_for_deterministic_signature_tests';
