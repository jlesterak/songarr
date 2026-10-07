import * as db from './db.js';
import * as worker from './worker.js';
import * as sync from './sync.js';
import { createApp } from './app.js';

const PORT = process.env.PORT || 3001;

await db.init();
const app = await createApp();
worker.startWorker();
sync.startSyncLoop();

app.listen(PORT, () => {
  console.log(`[Songarr Server] Running on http://localhost:${PORT}`);
});
