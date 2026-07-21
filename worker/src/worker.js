/**
 * MTG-collection API proxy.
 *
 * Deck sites cannot be called from a static page: Moxfield sits behind
 * Cloudflare and rejects anything that does not look like a browser (and a
 * browser cannot set Referer/Origin/Sec-Fetch-* — they are forbidden headers),
 * and Archidekt pins Access-Control-Allow-Origin to localhost. This Worker is
 * the smallest thing that closes both gaps.
 *
 * It is deliberately NOT a general proxy. Only four upstream shapes can ever be
 * produced, every parameter is rebuilt from validated input, and no part of the
 * caller's URL is concatenated into the upstream URL.
 */

// Production origins allowed to call this Worker. Add your Pages origin here
// if you fork. Any localhost port is also accepted so `wrangler dev` works
// against a local static server on whatever port happens to be free.
const ALLOWED_ORIGINS = ['https://yousdje.github.io'];
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const originAllowed = (origin) => ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN_RE.test(origin);

const MOXFIELD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://moxfield.com/',
  Origin: 'https://moxfield.com',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

const ARCHIDEKT_HEADERS = {
  'User-Agent': 'MTG-collection/1.0 (+https://github.com/yousdje/MTG-collection)',
  Accept: 'application/json',
};

// Cache TTLs. Deck lists move often, deck contents rarely; both are public data
// and every cache hit is one less request the upstream site has to serve.
const TTL_LIST = 300;
const TTL_DECK = 1800;

/** Usernames are the only free-form input; keep them boring. */
const USERNAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const MOXFIELD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ARCHIDEKT_ID_RE = /^[0-9]{1,12}$/;

function corsHeaders(origin) {
  const allowed = originAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin, ttl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/**
 * Build the upstream URL from validated pieces only.
 * Returns { url, headers, ttl } or throws a user-facing Error.
 */
function upstream(site, action, params) {
  if (site === 'moxfield') {
    if (action === 'decks') {
      const user = params.get('user') || '';
      if (!USERNAME_RE.test(user)) throw new Error('invalid username');
      const page = String(Math.min(parseInt(params.get('page') || '1', 10) || 1, 20));
      const u = new URL('https://api2.moxfield.com/v2/decks/search');
      u.searchParams.set('authorUserNames', user);
      u.searchParams.set('pageNumber', page);
      u.searchParams.set('pageSize', '50');
      u.searchParams.set('sortType', 'updated');
      u.searchParams.set('sortDirection', 'descending');
      return { url: u.toString(), headers: MOXFIELD_HEADERS, ttl: TTL_LIST };
    }
    if (action === 'deck') {
      const id = params.get('id') || '';
      if (!MOXFIELD_ID_RE.test(id)) throw new Error('invalid deck id');
      return {
        url: `https://api2.moxfield.com/v3/decks/all/${encodeURIComponent(id)}`,
        headers: MOXFIELD_HEADERS,
        ttl: TTL_DECK,
      };
    }
  }

  if (site === 'archidekt') {
    if (action === 'decks') {
      const user = params.get('user') || '';
      if (!USERNAME_RE.test(user)) throw new Error('invalid username');
      const page = String(Math.min(parseInt(params.get('page') || '1', 10) || 1, 20));
      const u = new URL('https://archidekt.com/api/decks/v3/');
      u.searchParams.set('ownerUsername', user);
      u.searchParams.set('pageSize', '50');
      u.searchParams.set('page', page);
      u.searchParams.set('orderBy', '-updatedAt');
      return { url: u.toString(), headers: ARCHIDEKT_HEADERS, ttl: TTL_LIST };
    }
    if (action === 'deck') {
      const id = params.get('id') || '';
      if (!ARCHIDEKT_ID_RE.test(id)) throw new Error('invalid deck id');
      return {
        url: `https://archidekt.com/api/decks/${id}/`,
        headers: ARCHIDEKT_HEADERS,
        ttl: TTL_DECK,
      };
    }
  }

  throw new Error('unknown site or action');
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (url.pathname === '/health') {
      return json({ ok: true }, 200, origin);
    }
    if (url.pathname !== '/api') {
      return json({ error: 'not found' }, 404, origin);
    }

    let target;
    try {
      target = upstream(url.searchParams.get('site'), url.searchParams.get('action'), url.searchParams);
    } catch (err) {
      return json({ error: err.message }, 400, origin);
    }

    // Serve from the edge cache when we can — this is what keeps us a polite
    // client when several people look up the same popular deck.
    const cacheKey = new Request(target.url, { method: 'GET' });
    const cache = caches.default;
    let upstreamResp = await cache.match(cacheKey);

    if (!upstreamResp) {
      try {
        upstreamResp = await fetch(target.url, { headers: target.headers });
      } catch (err) {
        return json({ error: 'upstream unreachable: ' + err.message }, 502, origin);
      }

      if (upstreamResp.ok) {
        const toCache = new Response(upstreamResp.clone().body, upstreamResp);
        toCache.headers.set('Cache-Control', `public, max-age=${target.ttl}`);
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }
    }

    if (!upstreamResp.ok) {
      // 403 from Moxfield means Cloudflare rejected us, not that the user is
      // missing. Say which so the UI can show something honest.
      const blocked = upstreamResp.status === 403;
      return json(
        {
          error: blocked
            ? 'This deck site is currently blocking automated access. Try again later, or use Archidekt.'
            : `upstream returned ${upstreamResp.status}`,
          status: upstreamResp.status,
          blocked,
        },
        upstreamResp.status === 404 ? 404 : 502,
        origin,
      );
    }

    let body;
    try {
      body = await upstreamResp.json();
    } catch {
      return json({ error: 'upstream sent a non-JSON response (likely a block page)' }, 502, origin);
    }

    return json(body, 200, origin, target.ttl);
  },
};
