import * as dns from "node:dns";

import { describe, expect, it } from "vitest";

import {
  createCaresLookup,
  resilientFetch,
  type CaresResolver,
  type FallbackLookup,
  type LookupCallback,
} from "../../src/core/resilientFetch";

/** Per-hostname scripted answers for the fake c-ares resolver (errors simulate ENOTFOUND/timeouts). */
interface ResolverScript {
  v4?: string[];
  v6?: string[];
  v4Error?: Error;
  v6Error?: Error;
}

/** Fake dns.promises.Resolver answering from a script; records every query for cache assertions. */
function fakeResolver(script: Record<string, ResolverScript>): { resolver: CaresResolver; queries: string[] } {
  const queries: string[] = [];
  const resolver: CaresResolver = {
    resolve4(hostname: string): Promise<string[]> {
      queries.push(`4:${hostname}`);
      const entry = script[hostname];
      return entry?.v4Error ? Promise.reject(entry.v4Error) : Promise.resolve(entry?.v4 ?? []);
    },
    resolve6(hostname: string): Promise<string[]> {
      queries.push(`6:${hostname}`);
      const entry = script[hostname];
      return entry?.v6Error ? Promise.reject(entry.v6Error) : Promise.resolve(entry?.v6 ?? []);
    },
  };
  return { resolver, queries };
}

interface FallbackRecord {
  hostname: string;
  options: dns.LookupOptions;
}

/** Fake getaddrinfo fallback; the answer callback may even fire twice to test the once-guard. */
function fakeFallback(answer: (record: FallbackRecord, callback: LookupCallback) => void): {
  lookup: FallbackLookup;
  calls: FallbackRecord[];
} {
  const calls: FallbackRecord[] = [];
  const lookup: FallbackLookup = (hostname, options, callback) => {
    calls.push({ hostname, options });
    answer({ hostname, options }, callback);
  };
  return { lookup, calls };
}

interface Delivery {
  err: NodeJS.ErrnoException | null;
  address: string | dns.LookupAddress[];
  family?: number;
}

/** Capture every delivery a lookup callback receives (the once-guard must keep this at 1). */
function capture(): { callback: LookupCallback; deliveries: Delivery[] } {
  const deliveries: Delivery[] = [];
  return {
    deliveries,
    callback: (err, address, family) => {
      deliveries.push({ err, address, family });
    },
  };
}

/** Flush the resolver's promise chain (allSettled + then) without waiting on real timers. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Answer "0.0.0.0" from the fallback by default (tests override when they care). */
function makeLookup(
  script: Record<string, ResolverScript>,
  answer?: (record: FallbackRecord, callback: LookupCallback) => void,
) {
  const fake = fakeResolver(script);
  const fallback = fakeFallback(
    answer ??
      ((_record, callback) => {
        callback(null, "0.0.0.0", 4);
      }),
  );
  const lookup = createCaresLookup({ resolver: fake.resolver, fallbackLookup: fallback.lookup });
  return { lookup, ...fake, fallback };
}
describe("createCaresLookup", () => {
  it("merges resolver answers IPv4-first and delivers the first single address", async () => {
    const { lookup } = makeLookup({ "example.com": { v4: ["192.0.2.10", "192.0.2.11"], v6: ["2001:db8::1"] } });
    const got = capture();
    lookup("example.com", {}, got.callback);
    await flush();
    expect(got.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]);
  });

  it("delivers the whole IPv4-first list when options.all is true", async () => {
    const { lookup } = makeLookup({ "example.com": { v4: ["192.0.2.10"], v6: ["2001:db8::1"] } });
    const got = capture();
    lookup("example.com", { all: true }, got.callback);
    await flush();
    expect(got.deliveries).toEqual([
      {
        err: null,
        address: [
          { address: "192.0.2.10", family: 4 },
          { address: "2001:db8::1", family: 6 },
        ],
      },
    ]);
  });

  it("filters to the requested family (4 keeps A records, 6 keeps AAAA records)", async () => {
    const { lookup } = makeLookup({ "example.com": { v4: ["192.0.2.10"], v6: ["2001:db8::1"] } });
    const got4 = capture();
    lookup("example.com", { family: 4 }, got4.callback);
    await flush();
    expect(got4.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]);

    const got6 = capture();
    lookup("example.com", { family: 6 }, got6.callback);
    await flush();
    expect(got6.deliveries).toEqual([{ err: null, address: "2001:db8::1", family: 6 }]);
  });

  it("falls back to getaddrinfo when the wanted family has no c-ares answer", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    const { lookup, fallback } = makeLookup({ "v4only.example": { v4: ["192.0.2.10"], v6Error: notFound } });
    const got = capture();
    lookup("v4only.example", { family: 6 }, got.callback);
    await flush();
    expect(fallback.calls).toEqual([{ hostname: "v4only.example", options: { family: 6 } }]);
    expect(got.deliveries).toEqual([{ err: null, address: "0.0.0.0", family: 4 }]);
  });

  it("falls back to getaddrinfo when every resolver query rejects", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    const { lookup, fallback } = makeLookup({
      "hosts-only.local": { v4Error: notFound, v6Error: notFound },
    });
    const got = capture();
    lookup("hosts-only.local", {}, got.callback);
    await flush();
    expect(fallback.calls.map((call) => call.hostname)).toEqual(["hosts-only.local"]);
    expect(got.deliveries).toEqual([{ err: null, address: "0.0.0.0", family: 4 }]);
  });

  it("propagates the fallback error when it also fails", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    const enoent = Object.assign(new Error("getaddrinfo ENOENT"), { code: "ENOENT" });
    const { lookup } = makeLookup({ "gone.example": { v4Error: notFound, v6Error: notFound } }, (_record, callback) => {
      callback(enoent, "");
    });
    const got = capture();
    lookup("gone.example", {}, got.callback);
    await flush();
    expect(got.deliveries).toEqual([{ err: enoent, address: "" }]);
  });

  it("does not cache failed lookups", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    const { lookup, queries } = makeLookup({ "hosts-only.local": { v4Error: notFound, v6Error: notFound } });
    const first = capture();
    lookup("hosts-only.local", {}, first.callback);
    await flush();
    const second = capture();
    lookup("hosts-only.local", {}, second.callback);
    await flush();
    // Both rounds reached the resolver: a negative answer must not be cached.
    expect(queries).toEqual(["4:hosts-only.local", "6:hosts-only.local", "4:hosts-only.local", "6:hosts-only.local"]);
  });

  it("answers IP literals synchronously via the fallback without touching c-ares", () => {
    const { lookup, queries, fallback } = makeLookup({});
    for (const literal of ["127.0.0.1", "::1"]) {
      const got = capture();
      lookup(literal, {}, got.callback);
      expect(got.deliveries).toEqual([{ err: null, address: "0.0.0.0", family: 4 }]); // no flush: sync path
      expect(fallback.calls.at(-1)?.hostname).toBe(literal);
    }
    expect(queries).toEqual([]);
  });

  it("serves a cached answer synchronously without re-querying the resolver", async () => {
    const { lookup, queries } = makeLookup({ "example.com": { v4: ["192.0.2.10"] } });
    const first = capture();
    lookup("example.com", {}, first.callback);
    await flush();
    expect(queries).toEqual(["4:example.com", "6:example.com"]);

    const second = capture();
    lookup("example.com", {}, second.callback);
    expect(second.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]); // sync cache hit
    expect(queries).toEqual(["4:example.com", "6:example.com"]); // resolver untouched
  });

  it("re-queries the resolver once the TTL expires (injected clock)", async () => {
    let clock = 1_000;
    const fake = fakeResolver({ "example.com": { v4: ["192.0.2.10"] } });
    const lookup = createCaresLookup({ resolver: fake.resolver, ttlMs: 5_000, now: () => clock });

    const first = capture();
    lookup("example.com", {}, first.callback);
    await flush();
    clock = 5_999; // still fresh
    lookup("example.com", {}, capture().callback);
    await flush();
    expect(fake.queries).toEqual(["4:example.com", "6:example.com"]);

    clock = 6_000; // expired
    const third = capture();
    lookup("example.com", {}, third.callback);
    await flush();
    expect(fake.queries).toEqual(["4:example.com", "6:example.com", "4:example.com", "6:example.com"]);
    expect(third.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]);
  });

  it("treats ttlMs 0 as always-expired (every lookup re-queries)", async () => {
    const fake = fakeResolver({ "example.com": { v4: ["192.0.2.10"] } });
    const lookup = createCaresLookup({ resolver: fake.resolver, ttlMs: 0 });
    lookup("example.com", {}, capture().callback);
    await flush();
    lookup("example.com", {}, capture().callback);
    await flush();
    expect(fake.queries).toEqual(["4:example.com", "6:example.com", "4:example.com", "6:example.com"]);
  });

  it("never calls the callback twice even when the fallback double-fires", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    const { lookup } = makeLookup(
      { "double.example": { v4Error: notFound, v6Error: notFound } },
      (_record, callback) => {
        callback(null, "192.0.2.99", 4);
        callback(null, "198.51.100.7", 4); // misbehaving fallback: second delivery must be dropped
      },
    );
    const got = capture();
    lookup("double.example", {}, got.callback);
    await flush();
    expect(got.deliveries).toEqual([{ err: null, address: "192.0.2.99", family: 4 }]);
  });

  it("serves concurrent lookups of one uncached host exactly once each", async () => {
    const { lookup } = makeLookup({ "example.com": { v4: ["192.0.2.10"] } });
    const first = capture();
    const second = capture();
    lookup("example.com", {}, first.callback);
    lookup("example.com", {}, second.callback);
    await flush();
    expect(first.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]);
    expect(second.deliveries).toEqual([{ err: null, address: "192.0.2.10", family: 4 }]);
  });
});

describe("resilientFetch", () => {
  it("delegates to globalThis.fetch AT CALL TIME and injects the dispatcher (patch-seam compat)", async () => {
    const original = globalThis.fetch;
    const seen: { url: string; hasDispatcher: boolean }[] = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(url), hasDispatcher: "dispatcher" in (init ?? {}) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    try {
      const res = await resilientFetch("https://example.test/api", { headers: { Accept: "application/json" } });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([{ url: "https://example.test/api", hasDispatcher: true }]);
  });
});
