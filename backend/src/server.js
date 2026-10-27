import { createApp } from './app.js';
import { config, integrationStatus } from './config.js';

const app = await createApp();
app.server.listen(config.port, () => {
  console.log(`Noble API listening on http://localhost:${config.port} (${config.env}) · database: ${app.db.dialect} · web app at /app`);
  for (const i of integrationStatus()) console.log(`  ${i.kind.padEnd(8)} ${i.id.padEnd(15)} ${i.mode}${i.mode === 'sandbox' ? '   unlock with ' + i.unlock_with.join(', ') : ''}`);
  if (!process.env.DOCS_ENCRYPTION_KEY) console.log(`  DOCS_ENCRYPTION_KEY not set: using a per-process key (${config.docsKey.slice(0, 8)}…). Documents uploaded now cannot be read after a restart. Set it in .env.`);
});
process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
