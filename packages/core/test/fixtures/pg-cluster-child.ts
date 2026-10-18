// A child process for pg-cluster.test.ts: starts a throwaway cluster, says where it is, and waits to be signalled.
import { startPgServer } from '../pg-cluster.ts';

const server = await startPgServer();
console.log(JSON.stringify({ dir: server.dir }));
setInterval(() => {}, 1000);
