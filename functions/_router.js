/**
 * UCD CSNL Module Picker — the routing half of this site's Pages Function.
 *
 * This file only adapts how the four functions under netlify/functions/ are
 * hosted; Pages compiles this directory (see `functions/[[path]].js`, the
 * catch-all route) and it imports those files, so the scrapers, parsers and
 * caching have exactly one implementation. `node server.js` (the local dev
 * server) still mounts the same files the way it always did. The `_` prefix
 * keeps this file out of the routing table: the only route is the catch-all
 * beside it.
 *
 * What the previous host used to provide, and what replaces it here:
 *
 *   storage     The functions had a blob store injected by the platform.
 *               Here each module is handed a KV-backed reader/writer through
 *               its own setStore() hook, with the same call shapes:
 *               get(store, key) / set(store, key, value). Keys keep their
 *               original store names — `csnl-catalogue/modules`,
 *               `csnl-assessments/map` and `csnl-suggestions/list` — in one KV
 *               namespace.
 *
 *   forms       The suggestions form was handled by the platform, which
 *               scanned the markup for it and intercepted its POST at "/".
 *               Nothing does that here, so the form posts to
 *               /.netlify/functions/suggestions, which stores it (see
 *               netlify/functions/suggestions.js).
 *
 *   schedule    The refresh used to be declared in the host's config as
 *               [functions."refresh-catalogue"] schedule, then as three Workers
 *               cron triggers — daily, in both. Pages has no cron triggers, so
 *               it is a GitHub Actions workflow now (.github/workflows/
 *               refresh-catalogue.yml), which calls the very same handler over
 *               this deployment's own route: twice a month, on the 1st and the
 *               15th, with the three passes inside that one run.
 *
 *   routing     The paths the frontend already calls, /.netlify/functions/*,
 *               are served from here. There is no _routes.json, so Pages runs
 *               this catch-all for every request — including plain asset
 *               requests — and everything that is not an API call is handed to
 *               env.ASSETS, which is what keeps the app's delivery unchanged.
 *
 * The handlers are called with the same minimal event the dev server passes
 * them ({ httpMethod, queryStringParameters }), and their { statusCode,
 * headers, body } results are turned straight back into a Response.
 *
 * The agent layer sits on top of the asset half and touches nothing the app
 * uses: `/`, `/about`, `/contact` and `/privacy` negotiate `text/markdown`,
 * their `.md` aliases always answer Markdown, and an unmatched path gets a
 * Markdown 404 when one is asked for. The documents themselves live in
 * `_agent-docs.js`.
 */

import catalogueModule from "../netlify/functions/catalogue.js";
import assessmentsModule from "../netlify/functions/assessments.js";
import timetableModule from "../netlify/functions/timetable.js";
import refreshModule from "../netlify/functions/refresh-catalogue.js";
import suggestionsModule from "../netlify/functions/suggestions.js";
import {
  DOCUMENTS,
  HTML_ALIASES,
  MARKDOWN_ALIASES,
  NOT_ACCEPTABLE_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "./_agent-docs.js";

const ROUTES = {
  "/.netlify/functions/catalogue": catalogueModule,
  "/.netlify/functions/assessments": assessmentsModule,
  "/.netlify/functions/timetable": timetableModule,
  "/.netlify/functions/refresh-catalogue": refreshModule,
  "/.netlify/functions/suggestions": suggestionsModule,
};

/** KV-backed stand-in for the blob stores the functions expect, carrying the platform
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
  suggestionsModule.setStore(backend);
}

/** Fetch a negotiated HTML document, falling back to its `.html` file: Pages
    resolves clean URLs itself, but the assets layer is the only place that
    knows how, and this keeps the behaviour identical under the local harness. */
async function fetchDocument(env, request, document) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && document.file) {
    const url = new URL(request.url);
    url.pathname = document.file;
    response = await env.ASSETS.fetch(new Request(url, request));
  }
  return response;
}

/** Advertise the Markdown alternative on the HTML response, and make sure a
    shared cache keys on Accept — without Vary it would hand one visitor's
    representation to the next. */
function withDocHeaders(response, document) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  if (response.status >= 200 && response.status < 300) {
    headers.set(
      "Link",
      `<${document.alternate}>; rel="alternate"; type="text/markdown", ` +
        `</llms.txt>; rel="describedby"; type="text/plain"`
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withVary(response) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Serve one of the agent-facing documents: alias, negotiated Markdown, or the
    real HTML page. Returns null when the pathname is not one of them. */
async function serveDocument(request, env, pathname) {
  const alias = MARKDOWN_ALIASES.get(pathname);
  if (alias) return markdownResponse(alias, 200, request.method);

  const document = DOCUMENTS.get(pathname);
  if (!document) return null;

  const choice = negotiate(request.headers.get("Accept"));
  if (choice === "markdown") return markdownResponse(document.markdown, 200, request.method);
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method);
  }
  return withDocHeaders(await fetchDocument(env, request, document), document);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname];
    if (!mod) {
      if (request.method === "GET" || request.method === "HEAD") {
        // One canonical address per page: `/about.html` redirects to `/about`,
        // so a search result or a pasted link never splits into two documents.
        const canonical = HTML_ALIASES.get(url.pathname);
        if (canonical) {
          const target = new URL(url);
          target.pathname = canonical;
          return new Response(null, {
            status: 308,
            headers: { Location: target.toString(), "Cache-Control": "public, max-age=3600" },
          });
        }

        const document = await serveDocument(request, env, url.pathname);
        if (document) return document;

        const response = await env.ASSETS.fetch(request);
        if (response.status === 404) {
          if (negotiate(request.headers.get("Accept")) === "markdown") {
            return markdownResponse(notFoundMarkdown(url.pathname), 404, request.method);
          }
          return withVary(response);
        }
        return response;
      }
      return env.ASSETS.fetch(request);
    }

    wireStorage(env, ctx);
    const event = {
      httpMethod: request.method,
      queryStringParameters: Object.fromEntries(url.searchParams),
    };
    // Only the suggestions endpoint reads a body, and reading it for every
    // request would consume the stream for the handlers that do not.
    if (request.method !== "GET" && request.method !== "HEAD") {
      event.headers = Object.fromEntries(request.headers);
      event.body = await request.text();
    }

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
};
