import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * Brave Search-backed provider for the web capability seam (ctx.web).
 * Calls the Brave Search Web API (GET {baseURL}/res/v1/web/search) with an
 * X-Subscription-Token key. No keyless mode: a key is required.
 */
const BRAVE_PROVIDER_ID = "brave";
const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com";
const DEFAULT_API_KEY_ENV = "BRAVE_API_KEY";
const USER_AGENT = "deepseek-harness/0.1.0";

export const name = "web-search-brave";
export const inject = ["web"];

export const Config = z.object({
  apiKey: z.string().role("secret"),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  // API count limit is 1-20 (default 20); the seam still enforces the bound.
  count: z.number().step(1).min(1).max(20).default(10),
  safesearch: z.union(["strict", "moderate", "off"]).default("moderate"),
  // text_decorations adds <b> highlight markers to snippets by default; the
  // seam renders raw text, so keep snippets clean.
  textDecorations: z.boolean().default(false),
  searchTimeoutMs: z.number().step(1).min(1).default(30000)
});

function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
  return {
    ...(literalApiKey === void 0 ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const credentials = ctx.get("credentials");
      if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
      return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    count: config.count ?? 10,
    safesearch: config.safesearch ?? "moderate",
    textDecorations: config.textDecorations ?? false,
    searchTimeoutMs: config.searchTimeoutMs ?? 30000
  };
}

class BraveSearchProvider {
  constructor(options) {
    this.options = options;
  }
  get id() {
    return BRAVE_PROVIDER_ID;
  }
  available() {
    const options = this.options();
    return (options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0;
  }
  async search(request, signal) {
    const options = this.options();
    const apiKey = await this.apiKey(options, signal);
    throwIfSearchAborted(signal);
    const url = new URL(options.baseURL.replace(/\/+$/u, "") + "/res/v1/web/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults ?? options.count));
    url.searchParams.set("safesearch", options.safesearch);
    url.searchParams.set("text_decorations", String(options.textDecorations));
    url.searchParams.set("country", "all");
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          "x-subscription-token": apiKey,
          "accept": "application/json",
          "user-agent": USER_AGENT
        },
        ...(signal !== void 0 ? { signal } : {})
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError("Brave search request failed: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (!response.ok) {
      throw new WebError(await apiErrorMessage(response, "Brave"), "WEB_PROVIDER_ERROR");
    }
    try {
      return mapBraveResponse(await response.json());
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      if (error instanceof WebError) throw error;
      throw new WebError("Brave returned an unprocessable response body: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
    }
  }
  async apiKey(options, signal) {
    throwIfSearchAborted(signal);
    if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
    let resolved;
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError("Brave search credential resolution failed: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (resolved !== void 0 && resolved.length > 0) return resolved;
    throw new WebError(
      "Brave search has no API key for " + JSON.stringify(options.apiKeyEnv ?? DEFAULT_API_KEY_ENV) +
      "; store it through the credentials service, export it in the launching environment, or set a literal apiKey in the web-search-brave config",
      "WEB_PROVIDER_CREDENTIAL_MISSING"
    );
  }
}

function mapBraveResponse(body) {
  const results = Array.isArray(body?.web?.results) ? body.web.results : [];
  const sources = results
    .filter((item) => typeof item?.url === "string" && item.url.length > 0)
    .map((item) => {
      const source = { url: item.url };
      if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
      if (typeof item.description === "string" && item.description.length > 0) source.snippet = item.description;
      const date = pickPublishedAt(item);
      if (date !== void 0) source.publishedAt = date;
      return source;
    });
  return { sources, truncated: false };
}

/** Brave: page_age is the ISO 8601 date (publishedAt); age is human-readable. */
function pickPublishedAt(item) {
  for (const key of ["page_age", "age"]) {
    const value = item?.[key];
    if (typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))) return value;
  }
  return void 0;
}

export function apply(ctx, config) {
  let current = () => config;
  ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(ctx, current())));
}

function abortable(operation, signal) {
  if (signal === void 0) return operation;
  if (signal.aborted) return Promise.reject(searchAborted(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(searchAborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
    });
  });
}

function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}

function searchAborted(signal, fallback) {
  return new WebError("Brave search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function apiErrorMessage(response, provider) {
  let message = provider + " API error (HTTP " + response.status + ")";
  try {
    const parsed = await response.json();
    const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (detail !== void 0 && detail.length > 0) message = detail;
  } catch {
    // non-JSON error body: keep the status-line message
  }
  return message;
}

export { BRAVE_PROVIDER_ID, BRAVE_DEFAULT_BASE_URL, DEFAULT_API_KEY_ENV, BraveSearchProvider, mapBraveResponse, pickPublishedAt };
