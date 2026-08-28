import * as dns from "node:dns";
import * as net from "node:net";

import { Agent } from "undici";

/**
 * Threadpool-free fetch for quota/model-catalog HTTP requests.
 *
 * Why this exists (see the 线程池纪律 section of AGENTS.md): the extension host
 * runs every extension's async filesystem work on a shared libuv threadpool
 * (default 4 threads). The global fetch (undici) resolves DNS via getaddrinfo,
 * which executes ON that threadpool. When DNS black-holes after a long-idle
 * code-server window reconnects, AbortSignal.timeout abandons the fetch promise
 * but CANNOT cancel a queued/running getaddrinfo — each parked lookup pins a
 * thread until it times out, and enough of them starve async fs for every
 * extension in the host ("everything freezes").
 *
 * Fix: route DNS through c-ares (dns.promises.Resolver), which is event-loop
 * integrated — it uses neither the libuv threadpool nor blocking syscalls. The
 * RequestGate concurrency cap and the auto-refresh breaker in quotaService stay
 * as belt-and-suspenders.
 */

/**
 * Structural slice of dns.promises.Resolver the lookup needs; the real Resolver
 * (c-ares) satisfies it and tests inject a fake without casting.
 */
export interface CaresResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Callback shape of net's lookup: (address, family) for single lookups, the address list when `all` is true. */
export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** getaddrinfo fallback shaped like dns.lookup; injectable for tests. */
export type FallbackLookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

/** Options for {@link createCaresLookup}; every dependency is injectable so unit tests need no network. */
export interface CaresLookupOptions {
  resolver?: CaresResolver;
  fallbackLookup?: FallbackLookup;
  /** Positive-answer cache lifetime per hostname (default 30s) to prevent lookup storms. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Build a net.connect-compatible `lookup` that resolves via c-ares instead of
 * getaddrinfo: query A and AAAA in parallel, merge IPv4-first, honor
 * `options.family`/`options.all`, cache positive answers for the TTL, and fall
 * back to dns.lookup only when c-ares yields nothing (hosts resolvable solely
 * through /etc/hosts or mDNS) — keeping the threadpool-parking path rare.
 */
export function createCaresLookup(opts: CaresLookupOptions = {}): net.LookupFunction {
  const resolver: CaresResolver = opts.resolver ?? new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  const fallbackLookup: FallbackLookup =
    opts.fallbackLookup ?? ((hostname, options, callback) => dns.lookup(hostname, options, callback));
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  /** Positive answers per hostname; negative results are never cached. */
  const cache = new Map<string, { entries: dns.LookupAddress[]; expiresAt: number }>();

  /** Deliver entries filtered to the wanted family; false = nothing usable for it. */
  const deliver = (entries: dns.LookupAddress[], family: number, all: boolean, callback: LookupCallback): boolean => {
    const usable = entries.filter((entry) => family === 0 || entry.family === family);
    if (usable.length === 0) {
      return false;
    }
    if (all) {
      callback(null, usable);
    } else {
      callback(null, usable[0].address, usable[0].family);
    }
    return true;
  };

  return (hostname, options, rawCallback): void => {
    // Exactly-once guard: whichever path answers (c-ares, cache, fallback), a
    // misbehaving double-firing fallback must never deliver a second time.
    let settled = false;
    const callback: LookupCallback = (err, address, family) => {
      if (settled) {
        return;
      }
      settled = true;
      rawCallback(err, address, family);
    };

    // IP literals never reach c-ares: getaddrinfo answers them locally without a
    // DNS round trip (and injected fallbacks must see them in tests).
    if (net.isIP(hostname) !== 0) {
      fallbackLookup(hostname, options, callback);
      return;
    }

    // dns.LookupOptions.family also accepts the "IPv4"/"IPv6" alias strings; normalize to 0/4/6.
    const requested = options.family ?? 0;
    const family = requested === "IPv4" ? 4 : requested === "IPv6" ? 6 : requested;
    // Synchronous Map read: a cached answer must not even await a microtask.
    const cached = cache.get(hostname);
    if (cached !== undefined && cached.expiresAt > now()) {
      if (deliver(cached.entries, family, options.all === true, callback)) {
        return;
      }
      // Stale-for-family cache entry (e.g. v4-only record, family 6 asked) — re-query below.
    }

    void Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then((results) => {
      const entries: dns.LookupAddress[] = [];
      if (results[0].status === "fulfilled") {
        for (const address of results[0].value) {
          entries.push({ address, family: 4 });
        }
      }
      if (results[1].status === "fulfilled") {
        for (const address of results[1].value) {
          entries.push({ address, family: 6 });
        }
      }
      if (entries.length > 0) {
        cache.set(hostname, { entries, expiresAt: now() + ttlMs });
      }
      if (deliver(entries, family, options.all === true, callback)) {
        return;
      }
      // No usable c-ares answer (ENOTFOUND/timeout/wrong family): getaddrinfo
      // still resolves /etc/hosts-only and mDNS names c-ares cannot see.
      fallbackLookup(hostname, options, callback);
    });
  };
}

/** Module-singleton dispatcher: c-ares lookup + bounded connect/keep-alive so sockets never linger. */
const dispatcher = new Agent({
  connect: { timeout: 10_000, lookup: createCaresLookup() },
  keepAliveMaxTimeout: 10_000,
});

/**
 * Drop-in fetch replacement routing DNS through c-ares (see module doc).
 * Delegates to globalThis.fetch — resolved AT CALL TIME — with the c-ares
 * dispatcher injected via the non-standard `init.dispatcher` key, which Node's
 * native (undici-based) fetch honors. Two consequences:
 *   - runtime patches of globalThis.fetch (the e2e suite's interception seam)
 *     keep working: the patched fetch ignores the extra key and answers itself;
 *   - if an environment's global fetch ever ignored `init.dispatcher`, the
 *     request merely falls back to default DNS resolution — the old behavior,
 *     still bounded by the RequestGate and the auto-refresh breaker.
 */
export const resilientFetch: typeof globalThis.fetch = (input, init) =>
  // dispatcher is not part of the DOM RequestInit type; bridge with one narrow
  // cast (never `any`) — the runtime key is read by undici's fetch implementation.
  globalThis.fetch(input, { ...(init ?? {}), dispatcher } as RequestInit);
