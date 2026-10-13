/**
 * UCD CSNL Module Picker — Cloudflare Worker.
 *
 * This file only adapts how the four functions under netlify/functions/ are
 * hosted; Wrangler bundles those files into this Worker, so the scrapers,
 * parsers and caching have exactly one implementation. `node server.js` (the
 * local dev server) still mounts the same files the way it always did.
 *
 * What the Netlify runtime used to provide, and what replaces it here:
 *
 *   storage     The functions got @netlify/blobs injected by the platform.
 *               Here each module is handed a KV-backed reader/writer through
 *               its own setStore() hook, with the same call shapes:
 *               get(store, key) / set(store, key, value). Keys keep their
 *               original store names — `csnl-catalogue/modules` and
 *               `csnl-assessments/map` — in one KV namespace.
 *
 *   schedule    The daily 00:00 UTC refresh (netlify.toml
 *               [functions."refresh-catalogue"] schedule) is a Workers cron
 *               trigger (see [triggers]) that runs the very same
 *               refresh-catalogue handler.
 *
 *   routing     The paths the frontend already calls, /.netlify/functions/*,
 *               are served from here. `run_worker_first` in wrangler.toml is
 *               scoped to that prefix, so asset requests never invoke this
 *               Worker and are served straight from the assets layer.
 *
 * The handlers are called with the same minimal event the dev server passes
 * them ({ httpMethod, queryStringParameters }), and their { statusCode,
 * headers, body } results are turned straight back into a Response.
 */

import catalogueModule from "./netlify/functions/catalogue.js";
import assessmentsModule from "./netlify/functions/assessments.js";
import timetableModule from "./netlify/functions/timetable.js";
import refreshModule from "./netlify/functions/refresh-catalogue.js";

const ROUTES = {
  "/.netlify/functions/catalogue": catalogueModule,
  "/.netlify/functions/assessments": assessmentsModule,
  "/.netlify/functions/timetable": timetableModule,
  "/.netlify/functions/refresh-catalogue": refreshModule,
};

/** KV-backed stand-in for the two Netlify blob stores, carrying the platform
    constraint the modules need to know about: a Workers free-plan invocation
    may make only 50 subrequests, and one module page costs two of them (the
    www.ucd.ie redirect to hub.ucd.ie). 44 leaves headroom for the catalogue
    call and for retries. Local Node runs (server.js, the harness) declare no
    budget and stay unbudgeted, so their behaviour is unchanged. */
const MAX_SUBREQUESTS = 44;

function storeFor(kv, ctx) {
  return {
    maxSubrequests: MAX_SUBREQUESTS,
    // The assessments module refreshes its map after answering, so that work
    // has to be registered with the runtime or it is cancelled with the
    // response. Node hosts have no equivalent and just let the promise run.
    waitUntil: (promise) => ctx.waitUntil(promise),
    async get(store, key) {
      return await kv.get(`${store}/${key}`, "json");
    },
    async set(store, key, value) {
      await kv.put(`${store}/${key}`, JSON.stringify(value));
    },
  };
}

/** Point the storage-capable modules at this request's KV namespace. Calling
    it per request is deliberate: it is cheap, and nothing then depends on
    import order having handed the modules a backend already. */
function wireStorage(env, ctx) {
  const backend = storeFor(env.STORE_KV, ctx);
  catalogueModule.setStore(backend);
  assessmentsModule.setStore(backend);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname];
    if (!mod) return env.ASSETS.fetch(request);

    wireStorage(env, ctx);
    const event = {
      httpMethod: request.method,
      queryStringParameters: Object.fromEntries(url.searchParams),
    };

    try {
      const result = await mod.handler(event);
      return new Response(result.body, {
        status: result.statusCode || 200,
        headers: result.headers || {},
      });
    } catch (error) {
      console.error(`${url.pathname} failed:`, (error && error.stack) || error);
      return new Response(JSON.stringify({ error: String((error && error.message) || error) }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  },

  async scheduled(controller, env, ctx) {
    wireStorage(env, ctx);
    ctx.waitUntil(
      refreshModule.handler().then(
        () => console.log("scheduled catalogue refresh finished"),
        (error) => console.error("scheduled catalogue refresh failed:", (error && error.stack) || error)
      )
    );
  },
};
