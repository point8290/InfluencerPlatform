import { createApp } from './app';
import { env } from './config/env';
import { sequelize } from './config/database';

async function main(): Promise<void> {
  // Verify the database is reachable before accepting traffic, so a bad
  // connection surfaces at startup rather than as a 500 on the first request.
  //
  // authenticate() only opens a connection — it does not create or alter
  // anything. The schema comes from `npm run migrate`, never from sync().
  await sequelize.authenticate();
  console.log(`Connected to MySQL database "${env.db.name}".`);

  const app = createApp();

  app.listen(env.port, () => {
    console.log(`API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start the server:', error);
  process.exit(1);
});
