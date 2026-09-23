// Local-dev fallback for the version shown in the app UI (topbar). In any
// deployed NOVAAPP01 container, NOVACONNECT_RELEASE_VERSION (set per release
// by Containerfile.overlay's RELEASE_VERSION build arg) takes priority over
// this — see appVersion() in helpers.js. This constant only matters when
// running outside that pipeline (e.g. `node src/server.js` locally), where
// package.json also isn't reliably kept in sync either.
module.exports = '1.0.38';
