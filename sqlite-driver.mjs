/**
 * Node 20 compatibility layer.
 * better-sqlite3 and node:sqlite expose the same synchronous methods used by
 * Zaininsta Studio: exec(), prepare().get/all/run(), and close().
 *
 * better-sqlite3 is the production driver on Node 20. Node 22+ can fall back
 * to its built-in module only when npm dependencies are not installed (useful
 * for local verification or minimal environments).
 */
let DatabaseSync;
try {
  ({ default: DatabaseSync } = await import('better-sqlite3'));
} catch (error) {
  // Never hide native-module installation/loading failures (ABI mismatch etc.).
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("'better-sqlite3'")) {
    throw error;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    throw new Error('Missing SQLite dependency. Run `npm install` in the Zaininsta Studio folder before `npm start`.', { cause: error });
  }
  ({ DatabaseSync } = await import('node:sqlite'));
}
export { DatabaseSync };
