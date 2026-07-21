/**
 * Deployment configuration.
 *
 * API_BASE is the Cloudflare Worker that fronts the deck sites. A static page
 * cannot call Moxfield or Archidekt directly — see worker/src/worker.js for why.
 *
 * If you fork this, deploy your own Worker (`cd worker && npx wrangler deploy`)
 * and put its URL in PROD_API below. Nothing else needs to change.
 */
(function () {
  const PROD_API = 'https://mtg-collection-api.ur-advisor.workers.dev';
  const DEV_API = 'http://localhost:8787';

  // Serving from localhost means someone is running `wrangler dev` next door.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

  window.MTG_CONFIG = {
    API_BASE: isLocal ? DEV_API : PROD_API,
  };
})();
