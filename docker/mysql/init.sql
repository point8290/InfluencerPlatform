-- Runs once, the first time the mysql_data volume is initialized.
-- Delete the volume (docker compose down -v) to make this run again.

-- Application database.
CREATE DATABASE IF NOT EXISTS credits_wallet
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Test database, created up front so `npm test` needs no manual setup.
--
-- The tests run against real MySQL rather than SQLite because the concurrency
-- test depends on SELECT ... FOR UPDATE row locks actually blocking. SQLite has
-- no row-level locking, so that test would pass there without proving anything.
CREATE DATABASE IF NOT EXISTS credits_wallet_test
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
