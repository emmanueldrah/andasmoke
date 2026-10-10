/**
 * CommonJS shim for the health module.
 *
 * The Electron main process needs the same health definition the renderer uses,
 * and it loads CommonJS. This forwards to the bundled implementation rather than
 * duplicating it, so there is one set of thresholds.
 */
const health = require('./api-bundle.cjs');

/**
 * Reports whether the local server can answer.
 *
 * Used at boot to decide whether the app has a working till, and by the
 * shutdown path so a failed backup or close is not silently swallowed.
 */
function localServerHealth(options = {}) {
  const path = typeof options.path === 'string' ? options.path : '/api/health';
  return health.checkLocalServer(path);
}

module.exports = {
  localServerHealth,
  checkLocalServer: health.checkLocalServer,
  startHealthChecks: health.startHealthChecks,
  stopHealthChecks: health.stopHealthChecks,
  currentHealth: health.currentHealth,
  isHealthRoute: health.isHealthRoute,
};