import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CandidatesFileSchema,
  LEGACY_RECORDS_SHA256,
  RULE,
  SEED,
  candidates,
  domainPrecheck,
  isEnvironmentFailure,
  judge,
  legacyRecordsSha256,
  markDuplicates,
  observe,
  parseArgs,
  parseTranco,
  planResume,
  rankForIndex,
  resumeFile,
  screenFrom,
  urlsFor,
  type CandidatesFile,
  type Judgement,
  type Observation,
  type PageFacts,
} from "./draw.js";

// Oracle values from `printf '<seed>:<i>' | shasum -a 256` + python int(hex[:8], 16) — no node involved.
const PINNED_FIRST_FIVE = [80782, 22399, 90298, 22996, 69549];

// Independent path: hex-string parse instead of the generator's Buffer.readUInt32BE.
function oracleRank(i: number): number {
  const hex = createHash("sha256")
    .update(`at-agent-bench-2026-09-18:${i}`)
    .digest("hex");
  return 10001 + (parseInt(hex.slice(0, 8), 16) % 90000);
}

describe("candidate generator", () => {
  it("uses the pre-registered seed", () => {
    expect(SEED).toBe("at-agent-bench-2026-09-18");
  });

  it("matches an independent node:crypto computation for the first five ranks", () => {
    const fromGenerator = [0, 1, 2, 3, 4].map((i) => rankForIndex(SEED, i));
    expect(fromGenerator).toEqual([0, 1, 2, 3, 4].map(oracleRank));
    expect(fromGenerator).toEqual(PINNED_FIRST_FIVE);
  });

  it("walks i = 0,1,2,… and yields the pinned ranks first", () => {
    const it5 = candidates(SEED);
    const first = Array.from({ length: 5 }, () => it5.next().value);
    expect(first).toEqual(
      PINNED_FIRST_FIVE.map((rank, i) => ({ i, rank, duplicate: false })),
    );
  });

  it("keeps every rank inside 10,001..100,000", () => {
    for (let i = 0; i < 5000; i++) {
      const r = rankForIndex(SEED, i);
      expect(r).toBeGreaterThanOrEqual(10001);
      expect(r).toBeLessThanOrEqual(100000);
    }
  });

  it("marks a rank already drawn as a duplicate and keeps i counting", () => {
    expect([...markDuplicates([5, 7, 5, 9, 7])]).toEqual([
      { i: 0, rank: 5, duplicate: false },
      { i: 1, rank: 7, duplicate: false },
      { i: 2, rank: 5, duplicate: true },
      { i: 3, rank: 9, duplicate: false },
      { i: 4, rank: 7, duplicate: true },
    ]);
  });
});

describe("parseTranco", () => {
  it("maps rank r to row r and strips CRLF", () => {
    expect(
      parseTranco("1,google.com\r\n2,cloudflare.com\r\n3,facebook.com\r\n"),
    ).toEqual(["google.com", "cloudflare.com", "facebook.com"]);
  });

  it("rejects a file whose ranks are out of order", () => {
    expect(() => parseTranco("1,a.com\n3,b.com\n")).toThrow(/row 2/);
  });
});

describe("urls and domain prechecks (Amendment 1 §1, §5, §6)", () => {
  it("builds https://<domain>/ and the one www fallback", () => {
    expect(urlsFor("example.org")).toEqual({
      primary: "https://example.org/",
      fallback: "https://www.example.org/",
    });
  });

  it("has no fallback for a domain that already starts with www., in any case", () => {
    expect(urlsFor("www.example.org").fallback).toBeNull();
    expect(urlsFor("WWW.Example.org").fallback).toBeNull();
    expect(urlsFor("wwwexample.org").fallback).toBe(
      "https://www.wwwexample.org/",
    );
  });

  it("rejects an adult keyword in the domain on rule 5, case-insensitively", () => {
    expect(domainPrecheck("essex.ac.uk")).toBe(5);
    expect(domainPrecheck("MyXXXsite.com")).toBe(5);
    expect(domainPrecheck("Adult-Shop.net")).toBe(5);
    expect(domainPrecheck("example.org")).toBeNull();
  });

  it("rejects exactly the listed registrable domains and their subdomains on rule 6", () => {
    for (const d of [
      "amazon.com",
      "smile.amazon.com",
      "AMAZON.COM",
      "mealkeyway.com",
      "fake-university.com",
      "cmu.edu",
      "www.cmu.edu",
      "troy.k12.mi.us",
      "www.troy.k12.mi.us",
      "troyroyalpalace.com",
      "w3.org",
      "validator.w3.org",
    ])
      expect(domainPrecheck(d), d).toBe(6);
  });

  it("does not exclude domains that merely share a name (amazon.eu, cmu.ac.th)", () => {
    for (const d of [
      "amazon.eu",
      "amazon.de",
      "amazon.com.br",
      "notamazon.com",
      "cmu.ac.th",
      "troy.k12.oh.us",
      "w3schools.com",
    ])
      expect(domainPrecheck(d), d).toBeNull();
  });

  it("puts rule 5 ahead of rule 6 when both fail before the load", () => {
    expect(domainPrecheck("sex.cmu.edu")).toBe(5);
  });
});

describe("environment failures (abort the run instead of judging the site)", () => {
  it("covers our own machine or network failing", () => {
    for (const code of [
      "ERR_INTERNET_DISCONNECTED",
      "ERR_NETWORK_CHANGED",
      "ERR_PROXY_CONNECTION_FAILED",
      "ERR_BLOCKED_BY_CLIENT",
    ])
      expect(isEnvironmentFailure(code), code).toBe(true);
  });

  it("leaves site errors, listed or not, to the rule-1 path (Amendment 1 §1, Amendment 2 §5)", () => {
    for (const code of [
      "ERR_NAME_NOT_RESOLVED",
      "ERR_CERT_DATE_INVALID",
      "ERR_CONNECTION_REFUSED",
      "ERR_TOO_MANY_REDIRECTS",
      "ERR_ABORTED",
      "ERR_QUIC_PROTOCOL_ERROR",
      "ERR_INVALID_HTTP_RESPONSE",
    ])
      expect(isEnvironmentFailure(code), code).toBe(false);
  });
});

const cleanPage: PageFacts = { botWall: false, focusable: 12, rta: false };
const okObs: Observation = {
  finalUrl: "https://example.org/",
  status: 200,
  contentType: "text/html; charset=utf-8",
  documentContentType: "text/html",
  download: false,
  cfMitigated: false,
  fallbackUsed: false,
  netError: null,
  primaryNetError: null,
  fallbackNetError: null,
  loadTimedOut: false,
  readTimedOut: false,
  loadIssue: null,
  page: cleanPage,
};
const noResponse: Observation = {
  ...okObs,
  finalUrl: null,
  status: null,
  contentType: null,
  documentContentType: null,
  page: null,
};

describe("judge", () => {
  it("accepts when every rule holds", () => {
    expect(judge("example.org", okObs)).toEqual({ result: "accept" });
  });

  it("labels a reject with the lowest-numbered failing rule (§7)", () => {
    const bad: Observation = {
      ...okObs,
      status: 403,
      documentContentType: "text/plain",
      cfMitigated: true,
      page: { botWall: true, focusable: 0, rta: true },
      finalUrl: "https://www.amazon.com/",
    };
    expect(judge("example.org", bad)).toEqual({ result: "reject", rule: 1 });
    expect(judge("example.org", { ...bad, status: 200 })).toEqual({
      result: "reject",
      rule: 2,
    });
    const html = { ...bad, status: 200, documentContentType: "text/html" };
    expect(judge("example.org", html)).toEqual({ result: "reject", rule: 3 });
    const noWall = {
      ...html,
      cfMitigated: false,
      page: { ...html.page!, botWall: false },
    };
    expect(judge("example.org", noWall)).toEqual({ result: "reject", rule: 4 });
    const focusable = { ...noWall, page: { ...noWall.page, focusable: 3 } };
    expect(judge("example.org", focusable)).toEqual({
      result: "reject",
      rule: 5,
    });
    const noRta = { ...focusable, page: { ...focusable.page, rta: false } };
    expect(judge("example.org", noRta)).toEqual({ result: "reject", rule: 6 });
  });

  it("rejects on rule 1 when the load got no response", () => {
    expect(judge("example.org", noResponse)).toEqual({
      result: "reject",
      rule: 1,
    });
  });

  it("treats text/html and application/xhtml+xml as HTML, case-insensitively (§2)", () => {
    for (const documentContentType of [
      "text/html",
      "application/xhtml+xml",
      "Application/XHTML+XML",
    ])
      expect(judge("example.org", { ...okObs, documentContentType })).toEqual({
        result: "accept",
      });
  });

  it("rejects a non-HTML document type, no document and a download on rule 2 (§2)", () => {
    expect(
      judge("example.org", { ...okObs, documentContentType: null }),
    ).toEqual({ result: "reject", rule: 2 });
    expect(
      judge("example.org", {
        ...okObs,
        documentContentType: "application/json",
      }),
    ).toEqual({ result: "reject", rule: 2 });
    expect(
      judge("example.org", {
        ...okObs,
        download: true,
        documentContentType: null,
        page: null,
      }),
    ).toEqual({ result: "reject", rule: 2 });
  });

  it("judges document.contentType, not the headers, when they disagree or are missing (Amendment 2 §4)", () => {
    const conflict = { ...okObs, contentType: "text/html, text/plain" };
    expect(
      judge("example.org", { ...conflict, documentContentType: "text/plain" }),
    ).toEqual({ result: "reject", rule: 2 });
    expect(
      judge("example.org", { ...conflict, documentContentType: "text/html" }),
    ).toEqual({ result: "accept" });
    expect(
      judge("example.org", {
        ...okObs,
        contentType: null,
        documentContentType: "text/html",
      }),
    ).toEqual({ result: "accept" });
  });

  it("rejects on rule 1 when the in-page read timed out (Amendment 2 §2)", () => {
    expect(
      judge("example.org", {
        ...okObs,
        readTimedOut: true,
        documentContentType: null,
        page: null,
      }),
    ).toEqual({ result: "reject", rule: 1 });
  });

  it("judges a document whose load timed out like any other (Amendment 2 §1)", () => {
    expect(judge("example.org", { ...okObs, loadTimedOut: true })).toEqual({
      result: "accept",
    });
  });

  it("rejects cf-mitigated or bot-wall text on rule 3 (§3)", () => {
    expect(judge("example.org", { ...okObs, cfMitigated: true })).toEqual({
      result: "reject",
      rule: 3,
    });
    expect(
      judge("example.org", { ...okObs, page: { ...cleanPage, botWall: true } }),
    ).toEqual({ result: "reject", rule: 3 });
  });

  it("rejects 0 light-DOM focusables on rule 4 (§4)", () => {
    expect(
      judge("example.org", { ...okObs, page: { ...cleanPage, focusable: 0 } }),
    ).toEqual({ result: "reject", rule: 4 });
  });

  it("checks the final URL host for adult keywords and dev-set/w3.org domains (§5, §6)", () => {
    expect(
      judge("example.org", { ...okObs, finalUrl: "https://XXX.example.net/" }),
    ).toEqual({ result: "reject", rule: 5 });
    expect(
      judge("example.org", {
        ...okObs,
        finalUrl: "https://www.amazon.com/dp/1",
      }),
    ).toEqual({ result: "reject", rule: 6 });
    expect(
      judge("example.org", { ...okObs, finalUrl: "https://www.W3.org./" }),
    ).toEqual({ result: "reject", rule: 6 });
    expect(
      judge("example.org", { ...okObs, finalUrl: "https://www.amazon.eu/" }),
    ).toEqual({ result: "accept" });
    expect(judge("amazon.eu", okObs)).toEqual({ result: "accept" });
    expect(judge("cmu.ac.th", okObs)).toEqual({ result: "accept" });
  });

  it("rejects an RTA label on rule 5", () => {
    expect(
      judge("example.org", { ...okObs, page: { ...cleanPage, rta: true } }),
    ).toEqual({ result: "reject", rule: 5 });
  });

  it("rejects on the domain precheck even when the load could not be judged", () => {
    const issue = { ...noResponse, loadIssue: "x" };
    expect(judge("sexy.example", issue)).toEqual({ result: "reject", rule: 5 });
    expect(judge("www.w3.org", issue)).toEqual({ result: "reject", rule: 6 });
  });

  it("stops on a load Amendment 1 does not settle", () => {
    expect(
      judge("example.org", { ...noResponse, loadIssue: "something new" }),
    ).toEqual({ result: "stop", reasons: ["something new"] });
  });
});

// ---- resume ----
const COMMITTED = JSON.parse(
  readFileSync(new URL("./candidates.json", import.meta.url), "utf8"),
) as { rule: string; candidates: Record<string, unknown>[] };
const FROZEN = COMMITTED.candidates.slice(0, 10);
const STOP_AT_10 = {
  i: 10,
  rank: 61381,
  domain: "noticiasdealava.eus",
  finalUrl: null,
  status: null,
  contentType: null,
  result: "stop",
};
const LIST = {
  id: "V3YPN" as const,
  url: "https://tranco-list.eu/download/V3YPN/1000000",
  file: "bench/vendor/tranco/tranco_V3YPN-1000000.csv",
  sha256: "eb755facd7174045ae81c41d0f8496d9b9ae667b6a7047c861cbe56c02a21445",
  rows: 1000000,
};
const BROWSER = {
  launch: "playwright chromium.launch() default (headless shell)",
  version: "143.0.7499.4",
  userAgent: "ua",
};
const TIMING = { waitUntil: "load", settleMs: 3000, loadTimeoutMs: 60000 };
// Shape of candidates.json as committed in 7440778 (before Amendment 1).
const legacyFile = () => ({
  rule: "bench/test-sites/SAMPLING-RULE.md @ 68ffa0a",
  seed: SEED,
  list: LIST,
  browser: BROWSER,
  timing: TIMING,
  startedAt: "2026-09-18T23:06:58.249Z",
  updatedAt: "2026-09-18T23:07:45.085Z",
  complete: false,
  acceptedCount: 5,
  stop: {
    i: 10,
    rank: 61381,
    domain: "noticiasdealava.eus",
    reasons: ["rule 1: …"],
  },
  candidates: [...FROZEN.map((r) => structuredClone(r)), STOP_AT_10],
});
// Synthetic list: every rank has a filler domain except the ranks the tests use.
function domainsFor(records: readonly object[]): string[] {
  const domains = Array.from({ length: 100_000 }, (_, k) => `r${k + 1}.test`);
  for (const { rank, domain } of records as { rank: number; domain: string }[])
    domains[rank - 1] = domain;
  return domains;
}

const NOW = "2026-09-19T01:00:00.000Z";
const planOpts = (records: readonly object[]) => ({
  domains: domainsFor(records),
  legacySha256: LEGACY_RECORDS_SHA256,
  rule: RULE,
  now: NOW,
});
const firstPlan = () =>
  planResume(legacyFile(), planOpts(legacyFile().candidates));
const amendedRecord = (
  i: number,
  result: string | number,
  domain?: string,
) => ({
  i,
  rank: rankForIndex(SEED, i),
  domain: domain ?? `r${rankForIndex(SEED, i)}.test`,
  finalUrl: null,
  status: null,
  contentType: null,
  result,
  fallbackUsed: false,
  netError: null,
});
// An amended-shape candidates.json written by an earlier resume run.
function amendedFile(over: Record<string, unknown>) {
  const first = firstPlan();
  return {
    rule: RULE,
    seed: SEED,
    list: LIST,
    notes: ["hand note"],
    legacyRecords: first.legacyRecords,
    browser: BROWSER,
    timing: TIMING,
    startedAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:01:00.000Z",
    complete: false,
    acceptedCount: 5,
    stop: null,
    inFlight: null,
    candidates: [...first.kept, amendedRecord(10, 1, "noticiasdealava.eus")],
    ...over,
  };
}

describe("resume (Amendment 1: keep i=0..9, resume at i=10)", () => {
  it("pins the frozen i=0..9 records that candidates.json still carries", () => {
    expect(FROZEN.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(legacyRecordsSha256(FROZEN)).toBe(LEGACY_RECORDS_SHA256);
  });

  it("keeps the 7440778 records byte-identical and re-attempts i=10", () => {
    const raw = legacyFile();
    const plan = planResume(raw, planOpts(raw.candidates));
    expect(plan.nextI).toBe(10);
    expect(JSON.stringify(plan.kept, null, 2)).toBe(
      JSON.stringify(FROZEN, null, 2),
    );
    expect(plan.acceptedCount).toBe(5);
    expect(plan.listSha256).toBe(LIST.sha256);
    expect(plan.legacyRecords).toMatchObject({
      commit: "7440778",
      count: 10,
      rule: "bench/test-sites/SAMPLING-RULE.md @ 68ffa0a",
      browser: BROWSER,
      startedAt: "2026-09-18T23:06:58.249Z",
      stop: raw.stop,
    });
    expect(plan.legacyRecords.note).toMatch(/fallbackUsed.*netError/);
    expect(plan).toMatchObject({
      notes: [],
      startedAt: null,
      browserVersion: null,
    });
  });

  it("carries a hand-written top-level note from the pre-amendment file forward", () => {
    const raw = {
      ...legacyFile(),
      notes: ["i=10 was loaded without a record"],
    };
    expect(planResume(raw, planOpts(raw.candidates)).notes).toEqual([
      "i=10 was loaded without a record",
    ]);
  });

  it("refuses frozen records that differ from the pin", () => {
    const raw = legacyFile();
    raw.candidates[1] = { ...raw.candidates[1], result: 1 };
    expect(() => planResume(raw, planOpts(raw.candidates))).toThrow(/7440778/);
  });

  it("refuses records whose rank or domain disagree with the seed and the list", () => {
    const raw = legacyFile();
    const domains = domainsFor(raw.candidates);
    domains[80782 - 1] = "other.test";
    expect(() =>
      planResume(raw, { ...planOpts(raw.candidates), domains }),
    ).toThrow(/i=0/);
  });

  it("continues an amended file after its last record, keeping its notes, start time and browser", () => {
    const raw = amendedFile({});
    const plan = planResume(raw, planOpts(raw.candidates));
    expect(plan.nextI).toBe(11);
    expect(plan.kept).toEqual(raw.candidates);
    expect(plan).toMatchObject({
      notes: ["hand note"],
      startedAt: "2026-09-19T00:00:00.000Z",
      browserVersion: BROWSER.version,
      legacyRecords: firstPlan().legacyRecords,
    });
  });

  it("refuses to re-attempt a candidate that stopped under the current rule", () => {
    const stopRec = amendedRecord(11, "stop");
    const raw = amendedFile({
      stop: {
        i: 11,
        rank: stopRec.rank,
        domain: stopRec.domain,
        reasons: ["x"],
      },
      candidates: [...amendedFile({}).candidates, stopRec],
    });
    expect(() => planResume(raw, planOpts(raw.candidates))).toThrow(
      /stopped at i=11.*amend/,
    );
  });

  it("re-attempts a stop made under an earlier rule and notes the replaced record", () => {
    const stopRec = amendedRecord(11, "stop");
    const raw = amendedFile({
      rule: "older rule",
      stop: {
        i: 11,
        rank: stopRec.rank,
        domain: stopRec.domain,
        reasons: ["x"],
      },
      candidates: [...amendedFile({}).candidates, stopRec],
    });
    const plan = planResume(raw, planOpts(raw.candidates));
    expect(plan.nextI).toBe(11);
    expect(plan.kept).toEqual(amendedFile({}).candidates);
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes[1]).toMatch(
      /i=11 .*stopped under older rule.*x.*re-attempted under/,
    );
  });

  it("re-attempts a load interrupted before its record was written, and notes it", () => {
    const inFlight = {
      i: 11,
      rank: rankForIndex(SEED, 11),
      domain: "cut.test",
      startedAt: "T0",
    };
    const raw = amendedFile({ inFlight });
    const plan = planResume(raw, planOpts(raw.candidates));
    expect(plan.nextI).toBe(11);
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes[1]).toMatch(
      /i=11 \(cut\.test\).*T0.*interrupted.*no record.*2026-09-19T01:00:00\.000Z/,
    );
  });

  it("refuses an in-flight marker that is not the next candidate", () => {
    const raw = amendedFile({
      inFlight: {
        i: 12,
        rank: rankForIndex(SEED, 12),
        domain: "x.test",
        startedAt: "T0",
      },
    });
    expect(() => planResume(raw, planOpts(raw.candidates))).toThrow(
      /in-flight/,
    );
  });

  it("refuses to resume a complete draw", () => {
    const raw = amendedFile({ complete: true });
    expect(() => planResume(raw, planOpts(raw.candidates))).toThrow(/complete/);
  });
});

// candidates.json as b089260 left it (stopped at i=22 under Amendment 1): the current file's i=0..21, which must still
// be b089260's, plus the stop record and metadata pinned from b089260.
const A1_RULE = "bench/test-sites/SAMPLING-RULE.md @ 0467eb6 (Amendment 1)";
// sha256 of JSON.stringify(candidates.slice(0, 22)) of candidates.json @ b089260.
const B089260_RECORDS_SHA256 =
  "ae154894835e5e0d50ace367a1cbd89c1002a0a678578b187e1ea05ecb4e814f";
const I22_REASON =
  'load did not fire within 60000 ms after an HTTP 200 response (§1 lists "a 60 s load timeout" but defines "fails to connect" as no HTTP response); Amendment 1 does not settle this';
function fileAtB089260() {
  const cur = structuredClone(COMMITTED) as typeof COMMITTED & {
    notes: string[];
  };
  // Spreading keeps the file's key order, so the rebuilt file serialises like the committed one.
  return {
    ...cur,
    rule: A1_RULE,
    notes: cur.notes.slice(0, 1),
    updatedAt: "2026-09-19T02:20:23.687Z",
    complete: false,
    acceptedCount: 14,
    stop: { i: 22, rank: 77440, domain: "dfbocai.net", reasons: [I22_REASON] },
    inFlight: null,
    candidates: [
      ...cur.candidates.slice(0, 22),
      {
        i: 22,
        rank: 77440,
        domain: "dfbocai.net",
        finalUrl: "https://www.dfbocai.net/en",
        status: 200,
        contentType: null,
        result: "stop",
        fallbackUsed: false,
        netError: null,
      },
    ],
  };
}

describe("resume under Amendment 2 (the b089260 file stopped at i=22)", () => {
  const committedRaw = fileAtB089260;

  it("names the Amendment 2 commit", () => {
    expect(RULE).toBe(
      "bench/test-sites/SAMPLING-RULE.md @ 10f9c86 (Amendment 2)",
    );
  });

  it("candidates.json still holds b089260's i=0..21 unchanged and validates", () => {
    expect(legacyRecordsSha256(COMMITTED.candidates.slice(0, 22))).toBe(
      B089260_RECORDS_SHA256,
    );
    expect(() => CandidatesFileSchema.parse(COMMITTED)).not.toThrow();
    expect(() => CandidatesFileSchema.parse(fileAtB089260())).not.toThrow();
  });

  it("keeps i=0..21 byte-identical, re-attempts i=22 and discloses the second load", () => {
    const plan = planResume(
      committedRaw(),
      planOpts(committedRaw().candidates),
    );
    expect(plan.nextI).toBe(22);
    expect(plan.acceptedCount).toBe(14);
    expect(JSON.stringify(plan.kept, null, 2)).toBe(
      JSON.stringify(committedRaw().candidates.slice(0, 22), null, 2),
    );
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes[1]).toBe(
      `i=22 (dfbocai.net) stopped under ${A1_RULE} (load did not fire within 60000 ms after an HTTP 200 response (§1 lists "a 60 s load timeout" but defines "fails to connect" as no HTTP response); Amendment 1 does not settle this); that stop record is dropped and i=22 re-attempted under ${RULE} by the resume started ${NOW}.`,
    );
  });

  it("would refuse the re-attempt under the Amendment 1 rule", () => {
    expect(() =>
      planResume(committedRaw(), {
        ...planOpts(committedRaw().candidates),
        rule: A1_RULE,
      }),
    ).toThrow(/stopped at i=22.*amend/);
  });

  it("writes Amendment 2 records from i=22 after the Amendment 1 ones, and the file validates", async () => {
    const plan = planResume(
      committedRaw(),
      planOpts(committedRaw().candidates),
    );
    const start = resumeFile(plan, { list: LIST, browser: BROWSER, now: NOW });
    const { file } = await screenFrom(start, {
      domains: planOpts(committedRaw().candidates).domains,
      nextI: plan.nextI,
      maxCandidates: 1,
      observe: async () => ({ ...okObs, loadTimedOut: true }),
      save: async (f) => void CandidatesFileSchema.parse(f),
      now: () => NOW,
      log: () => {},
    });
    expect(file.notes).toEqual(plan.notes);
    expect(file.candidates.at(-1)).toEqual({
      i: 22,
      rank: 77440,
      domain: "dfbocai.net",
      finalUrl: "https://example.org/",
      status: 200,
      contentType: "text/html; charset=utf-8",
      result: "accept",
      fallbackUsed: false,
      netError: null,
      primaryNetError: null,
      fallbackNetError: null,
      documentContentType: "text/html",
    });
    expect(() => CandidatesFileSchema.parse(file)).not.toThrow();
  });

  it("refuses an Amendment 1-shaped record at i >= 22, or a later record without Amendment 2's fields", () => {
    const plan = planResume(
      committedRaw(),
      planOpts(committedRaw().candidates),
    );
    const start = resumeFile(plan, { list: LIST, browser: BROWSER, now: NOW });
    const a1At22 = { ...amendedRecord(22, 1), domain: "dfbocai.net" };
    expect(() =>
      CandidatesFileSchema.parse({
        ...start,
        candidates: [...start.candidates, a1At22],
      }),
    ).toThrow(/Amendment 2/);
    const a2At10 = {
      ...amendedRecord(10, 1),
      primaryNetError: null,
      fallbackNetError: null,
      documentContentType: null,
    };
    expect(() =>
      CandidatesFileSchema.parse({
        ...start,
        candidates: [
          ...start.candidates.slice(0, 10),
          a2At10,
          amendedRecord(11, 1),
        ],
      }),
    ).toThrow(/Amendment 2/);
  });
});

describe("parseArgs", () => {
  it("requires --resume, since i=0..9 are frozen", () => {
    expect(() => parseArgs([])).toThrow(/--resume/);
    expect(parseArgs(["--resume"])).toEqual({ maxCandidates: null });
  });

  it("takes --max-candidates as a positive integer", () => {
    expect(parseArgs(["--resume", "--max-candidates", "4"])).toEqual({
      maxCandidates: 4,
    });
    for (const bad of [[], ["0"], ["-1"], ["2.5"], ["abc"]])
      expect(
        () => parseArgs(["--resume", "--max-candidates", ...bad]),
        bad.join(),
      ).toThrow(/positive integer/);
  });
});

describe("screenFrom (the resume loop, with a stub load)", () => {
  function setup(opts: {
    observe?: (
      primary: string,
      fallback: string | null,
    ) => Promise<Observation>;
    maxCandidates?: number;
    domains?: string[];
  }) {
    const plan = firstPlan();
    const start = resumeFile(plan, { list: LIST, browser: BROWSER, now: NOW });
    const saves: CandidatesFile[] = [];
    const loads: string[] = [];
    const run = () =>
      screenFrom(start, {
        domains: opts.domains ?? domainsFor(plan.kept),
        nextI: plan.nextI,
        maxCandidates: opts.maxCandidates ?? null,
        observe: async (primary, fallback) => {
          loads.push(primary);
          // The in-flight marker must be on disk before the load starts.
          expect(saves.at(-1)?.inFlight?.domain).toBe(
            new URL(primary).hostname,
          );
          return (opts.observe ?? (async () => okObs))(primary, fallback);
        },
        save: async (f) => {
          saves.push(CandidatesFileSchema.parse(f) && f);
        },
        now: () => NOW,
        log: () => {},
      });
    return { plan, start, saves, loads, run };
  }

  it("builds the resumed file with the frozen records, their notes and the amended rule", () => {
    const { start } = setup({});
    expect(start).toMatchObject({
      rule: RULE,
      startedAt: NOW,
      complete: false,
      acceptedCount: 5,
      stop: null,
      inFlight: null,
      notes: [],
    });
    expect(JSON.stringify(start.candidates, null, 2)).toBe(
      JSON.stringify(FROZEN, null, 2),
    );
    expect(() => CandidatesFileSchema.parse(start)).not.toThrow();
  });

  it("screens from i=10 until 20 are accepted, then marks the draw complete", async () => {
    const { run, saves, loads } = setup({});
    const { file, outcome } = await run();
    expect(outcome).toBe("complete");
    expect(file.acceptedCount).toBe(20);
    expect(file.candidates.map((r) => r.i)).toEqual(
      Array.from({ length: 25 }, (_, k) => k),
    );
    expect(loads).toHaveLength(15);
    expect(file).toMatchObject({ complete: true, inFlight: null, stop: null });
    expect(saves.at(-1)).toEqual(file);
    expect(JSON.stringify(file.candidates.slice(0, 10), null, 2)).toBe(
      JSON.stringify(FROZEN, null, 2),
    );
  });

  it("records fallbackUsed, netError and each load's own error on every new record", async () => {
    const { run } = setup({
      maxCandidates: 1,
      observe: async () => ({
        ...noResponse,
        fallbackUsed: true,
        netError: "ERR_TOO_MANY_REDIRECTS",
        primaryNetError: "ERR_CERT_DATE_INVALID",
        fallbackNetError: "ERR_TOO_MANY_REDIRECTS",
      }),
    });
    const { file } = await run();
    expect(file.candidates.at(-1)).toEqual({
      i: 10,
      rank: 61381,
      domain: "r61381.test",
      finalUrl: null,
      status: null,
      contentType: null,
      result: 1,
      fallbackUsed: true,
      netError: "ERR_TOO_MANY_REDIRECTS",
      primaryNetError: "ERR_CERT_DATE_INVALID",
      fallbackNetError: "ERR_TOO_MANY_REDIRECTS",
      documentContentType: null,
    });
  });

  it("pauses after --max-candidates records with nothing in flight", async () => {
    const { run } = setup({ maxCandidates: 3 });
    const { file, outcome } = await run();
    expect(outcome).toBe("paused");
    expect(file.candidates).toHaveLength(13);
    expect(file).toMatchObject({
      complete: false,
      inFlight: null,
      acceptedCount: 8,
    });
  });

  it("rejects a precheck-failing domain on rule 5/6 without loading it", async () => {
    const domains = domainsFor(firstPlan().kept);
    domains[61381 - 1] = "Hot-SEX-shop.test";
    const { run, loads } = setup({ maxCandidates: 1, domains });
    const { file } = await run();
    expect(loads).toEqual([]);
    expect(file.candidates.at(-1)).toMatchObject({
      i: 10,
      result: 5,
      finalUrl: null,
      status: null,
      fallbackUsed: false,
      netError: null,
    });
  });

  it("stops at a load Amendment 1 does not settle and records why", async () => {
    let n = 0;
    const { run } = setup({
      observe: async () =>
        ++n === 2 ? { ...noResponse, loadIssue: "new case" } : okObs,
    });
    const { file, outcome } = await run();
    expect(outcome).toBe("stopped");
    expect(file.candidates.at(-1)).toMatchObject({ i: 11, result: "stop" });
    expect(file.stop).toEqual({
      i: 11,
      rank: rankForIndex(SEED, 11),
      domain: `r${rankForIndex(SEED, 11)}.test`,
      reasons: ["new case"],
    });
    expect(file).toMatchObject({ complete: false, inFlight: null });
  });
});

// ---- live loads against local fixtures ----
const HTML = { "content-type": "text/html; charset=utf-8" };
const LINK = '<a href="/">home</a>';
const NAV_TO_OK =
  '<script>addEventListener("load", () => setTimeout(() => { location.href = "/ok" }, 100))</script>';
const XHTML = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${LINK}</body></html>`;

type Route =
  | { status: number; headers: Record<string, string | string[]>; body: string }
  | "hang"
  | "destroy"
  | "reset"
  | "redirect-to-closed"
  | "js-to-closed";
const ROUTES: Record<string, Route> = {
  "/ok": { status: 200, headers: HTML, body: `<title>ok</title>${LINK}` },
  "/redirect": { status: 302, headers: { location: "/ok" }, body: "" },
  "/redirect-dead": "redirect-to-closed",
  "/js-to-dead": "js-to-closed",
  "/loop": { status: 302, headers: { location: "/loop" }, body: "" },
  "/404": { status: 404, headers: HTML, body: LINK },
  "/404-empty": { status: 404, headers: HTML, body: "" },
  "/json": {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  },
  "/no-ctype": { status: 200, headers: {}, body: LINK },
  "/no-ctype-text": { status: 200, headers: {}, body: "just words, no markup" },
  // Two Content-Type headers: Chromium uses the last one (Amendment 2 §4 judges what Chromium used).
  "/ct-conflict-plain-last": {
    status: 200,
    headers: { "content-type": ["text/html", "text/plain"] },
    body: `<!doctype html><title>t</title>${LINK}`,
  },
  "/ct-conflict-html-last": {
    status: 200,
    headers: { "content-type": ["text/plain", "text/html"] },
    body: `<!doctype html><title>t</title>${LINK}`,
  },
  "/204": { status: 204, headers: {}, body: "" },
  "/xhtml": {
    status: 200,
    headers: { "content-type": "Application/XHTML+XML; charset=utf-8" },
    body: XHTML,
  },
  "/download": {
    status: 200,
    headers: { ...HTML, "content-disposition": "attachment; filename=x.html" },
    body: LINK,
  },
  "/empty": "destroy",
  "/reset": "reset",
  "/cf": {
    status: 200,
    headers: { ...HTML, "cf-mitigated": "challenge" },
    body: LINK,
  },
  // cf-mitigated only on a subresource, not on a navigation response (Amendment 2 §3).
  "/cf-sub": { status: 200, headers: HTML, body: `${LINK}<img src="/cf-img">` },
  "/cf-img": {
    status: 403,
    headers: { "content-type": "text/plain", "cf-mitigated": "challenge" },
    body: "",
  },
  "/cf-then-nav": {
    status: 403,
    headers: { ...HTML, "cf-mitigated": "challenge" },
    body: NAV_TO_OK,
  },
  "/wall": {
    status: 200,
    headers: HTML,
    body: `<p>please verify you are human</p>${LINK}`,
  },
  "/wall-case": {
    status: 200,
    headers: HTML,
    body: `<p>Protected by reCAPTCHA</p>${LINK}`,
  },
  "/title-wall": {
    status: 200,
    headers: HTML,
    body: `<title>Just a moment...</title>${LINK}`,
  },
  "/hidden-wall": {
    status: 200,
    headers: HTML,
    body: `<p hidden>captcha</p>${LINK}`,
  },
  "/no-focus": { status: 200, headers: HTML, body: "<p>plain text only</p>" },
  "/iframe-only": {
    status: 200,
    headers: HTML,
    body: '<iframe src="/ok"></iframe>',
  },
  "/shadow-only": {
    status: 200,
    headers: HTML,
    body: '<div id="h"></div><script>document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = \'<a href="/">x</a>\'</script>',
  },
  "/rta": {
    status: 200,
    headers: HTML,
    body: `<meta name="rating" content="RTA-5042-1996-1400-1577-RTA">${LINK}`,
  },
  "/rta-case": {
    status: 200,
    headers: HTML,
    body: `<meta name=" RATING " content=" rta-5042-1996-1400-1577-rta ">${LINK}`,
  },
  "/rta-adult": {
    status: 200,
    headers: HTML,
    body: `<meta name="Rating" content="Adult">${LINK}`,
  },
  "/rating-general": {
    status: 200,
    headers: HTML,
    body: `<meta name="rating" content="general">${LINK}`,
  },
  "/js-nav": { status: 200, headers: HTML, body: NAV_TO_OK },
  "/push": {
    status: 200,
    headers: HTML,
    body: `${LINK}<script>history.pushState({}, "", "/pushed")</script>`,
  },
  "/hang": { status: 200, headers: HTML, body: `${LINK}<img src="/never">` },
  "/never": "hang",
  "/spin": {
    status: 200,
    headers: HTML,
    body: `${LINK}<script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 50))</script>`,
  },
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

// The reject rule of a verdict, or null for accept/stop.
const rejectRule = (v: Judgement): number | null =>
  v.result === "reject" ? v.rule : null;

describe(
  "observe + judge on local fixtures (Chromium)",
  { timeout: 30_000 },
  () => {
    let browser: Browser;
    let base = "";
    let tlsBase = "";
    let closedBase = "";
    let certBase = "";
    const certDir = mkdtempSync(join(tmpdir(), "draw-cert-"));
    // Self-signed, so Chromium fails the handshake with an ERR_CERT_* code (i=10's failure family).
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const certServer = createTlsServer(
      {
        key: readFileSync(join(certDir, "key.pem")),
        cert: readFileSync(join(certDir, "cert.pem")),
      },
      (_req, res) => res.writeHead(200, HTML).end(LINK),
    );
    const server = createServer((req, res) => {
      const route = ROUTES[req.url ?? ""];
      if (route === "hang") return; // never answer
      if (route === "destroy") return void req.socket.destroy();
      if (route === "reset") return void req.socket.resetAndDestroy();
      if (route === "redirect-to-closed")
        return void res.writeHead(302, { location: `${closedBase}/` }).end();
      if (route === "js-to-closed")
        return void res
          .writeHead(200, HTML)
          .end(`<script>location.href = "${closedBase}/"</script>${LINK}`);
      if (!route) return void res.writeHead(500).end();
      res.writeHead(route.status, route.headers).end(route.body);
    });
    const fast = { settleMs: 300, loadTimeoutMs: 5_000, evalTimeoutMs: 5_000 };

    beforeAll(async () => {
      const port = await listen(server);
      base = `http://127.0.0.1:${port}`;
      // https:// to a plain-HTTP port: the TLS handshake fails (ERR_SSL_PROTOCOL_ERROR).
      tlsBase = `https://127.0.0.1:${port}`;
      const closed = createServer();
      closedBase = `http://127.0.0.1:${await listen(closed)}`;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      certBase = `https://127.0.0.1:${await listen(certServer)}`;
      browser = await chromium.launch();
    }, 30_000);

    afterAll(async () => {
      await browser?.close();
      server.closeAllConnections();
      certServer.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => certServer.close(() => resolve()));
      rmSync(certDir, { recursive: true, force: true });
    });

    async function screenPath(path: string, timing = fast) {
      const obs = await observe(browser, `${base}${path}`, null, timing);
      return { obs, verdict: judge("fixture.test", obs) };
    }

    it("accepts a plain 200 HTML page with a link", async () => {
      const { obs, verdict } = await screenPath("/ok");
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        contentType: "text/html; charset=utf-8",
        fallbackUsed: false,
        netError: null,
      });
      expect(verdict).toEqual({ result: "accept" });
    });

    it("follows an HTTP redirect to the final document", async () => {
      const { obs, verdict } = await screenPath("/redirect");
      expect(obs).toMatchObject({ finalUrl: `${base}/ok`, status: 200 });
      expect(verdict).toEqual({ result: "accept" });
    });

    it("rejects a 404 on rule 1, with or without a body, and never falls back after a response", async () => {
      expect((await screenPath("/404")).verdict).toEqual({
        result: "reject",
        rule: 1,
      });
      const empty = await screenPath("/404-empty");
      expect(empty.obs.status).toBe(404);
      expect(empty.verdict).toEqual({ result: "reject", rule: 1 });
      const obs = await observe(browser, `${base}/404`, `${base}/ok`, fast);
      expect(obs).toMatchObject({ status: 404, fallbackUsed: false });
    });

    it("accepts application/xhtml+xml as HTML", async () => {
      const { obs, verdict } = await screenPath("/xhtml");
      expect(obs.documentContentType).toBe("application/xhtml+xml");
      expect(verdict).toEqual({ result: "accept" });
    });

    it("rejects a non-HTML document on rule 2", async () => {
      const json = await screenPath("/json");
      expect(json.obs.documentContentType).toBe("application/json");
      expect(json.verdict).toEqual({ result: "reject", rule: 2 });
    });

    it("judges a missing Content-Type by the type Chromium sniffed (Amendment 2 §4)", async () => {
      const html = await screenPath("/no-ctype");
      expect(html.obs).toMatchObject({
        status: 200,
        contentType: null,
        documentContentType: "text/html",
      });
      expect(html.verdict).toEqual({ result: "accept" });
      const text = await screenPath("/no-ctype-text");
      expect(text.obs).toMatchObject({
        contentType: null,
        documentContentType: "text/plain",
      });
      expect(text.verdict).toEqual({ result: "reject", rule: 2 });
    });

    it("judges conflicting Content-Type headers by document.contentType and records the headers (Amendment 2 §4)", async () => {
      const plain = await screenPath("/ct-conflict-plain-last");
      expect(plain.obs).toMatchObject({
        contentType: "text/html, text/plain",
        documentContentType: "text/plain",
        loadIssue: null,
      });
      expect(plain.verdict).toEqual({ result: "reject", rule: 2 });
      const html = await screenPath("/ct-conflict-html-last");
      expect(html.obs).toMatchObject({
        contentType: "text/plain, text/html",
        documentContentType: "text/html",
      });
      expect(html.verdict).toEqual({ result: "accept" });
    });

    it("rejects a download on rule 2 and records its response", async () => {
      const { obs, verdict } = await screenPath("/download");
      expect(obs).toMatchObject({
        download: true,
        finalUrl: `${base}/download`,
        status: 200,
      });
      expect(verdict).toEqual({ result: "reject", rule: 2 });
    });

    it("rejects cf-mitigated on the final response on rule 3", async () => {
      const { obs, verdict } = await screenPath("/cf");
      expect(obs.cfMitigated).toBe(true);
      expect(verdict).toEqual({ result: "reject", rule: 3 });
    });

    it("ignores cf-mitigated on a subresource (Amendment 2 §3)", async () => {
      const { obs, verdict } = await screenPath("/cf-sub");
      expect(obs.cfMitigated).toBe(false);
      expect(verdict).toEqual({ result: "accept" });
    });

    it("rejects cf-mitigated on an earlier main-frame response of the load on rule 3", async () => {
      const { obs, verdict } = await screenPath("/cf-then-nav", {
        settleMs: 1_500,
        loadTimeoutMs: 5_000,
        evalTimeoutMs: 5_000,
      });
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        cfMitigated: true,
      });
      expect(verdict).toEqual({ result: "reject", rule: 3 });
    });

    it("matches the bot-wall regex case-insensitively in body text and title", async () => {
      expect(rejectRule((await screenPath("/wall")).verdict)).toBe(3);
      expect(rejectRule((await screenPath("/wall-case")).verdict)).toBe(3);
      expect(rejectRule((await screenPath("/title-wall")).verdict)).toBe(3);
    });

    it("reads visible body text only (innerText skips hidden text)", async () => {
      expect((await screenPath("/hidden-wall")).verdict).toEqual({
        result: "accept",
      });
    });

    it("counts focusables in the main document's light DOM only (rule 4)", async () => {
      for (const path of ["/no-focus", "/iframe-only", "/shadow-only"]) {
        const { obs, verdict } = await screenPath(path);
        expect(obs.page?.focusable, path).toBe(0);
        expect(verdict, path).toEqual({ result: "reject", rule: 4 });
      }
    });

    it("rejects an RTA label on rule 5, case-insensitive after trimming", async () => {
      for (const path of ["/rta", "/rta-case", "/rta-adult"])
        expect((await screenPath(path)).verdict, path).toEqual({
          result: "reject",
          rule: 5,
        });
      expect((await screenPath("/rating-general")).verdict).toEqual({
        result: "accept",
      });
    });

    it("judges the document present at load + settle after a JS navigation", async () => {
      const { obs, verdict } = await screenPath("/js-nav", {
        settleMs: 1_500,
        loadTimeoutMs: 5_000,
        evalTimeoutMs: 5_000,
      });
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        cfMitigated: false,
      });
      expect(verdict).toEqual({ result: "accept" });
    });

    it("records the pushState URL while judging the original document", async () => {
      const { obs, verdict } = await screenPath("/push");
      expect(obs).toMatchObject({ finalUrl: `${base}/pushed`, status: 200 });
      expect(verdict).toEqual({ result: "accept" });
    });

    it("falls back to www once after a TLS error and judges the fallback", async () => {
      const obs = await observe(browser, `${tlsBase}/`, `${base}/ok`, fast);
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        netError: "ERR_SSL_PROTOCOL_ERROR",
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "accept" });
    });

    it("falls back to www once after a certificate error and judges the fallback", async () => {
      const obs = await observe(browser, `${certBase}/`, `${base}/ok`, fast);
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
      });
      expect(obs.netError).toMatch(/^ERR_CERT_/);
      expect(judge("fixture.test", obs)).toEqual({ result: "accept" });
    });

    it("falls back after a redirect whose target fails to connect", async () => {
      const obs = await observe(
        browser,
        `${base}/redirect-dead`,
        `${base}/ok`,
        fast,
      );
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        netError: "ERR_CONNECTION_REFUSED",
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "accept" });
    });

    it("falls back after an empty response or a connection reset", async () => {
      for (const [path, code] of [
        ["/empty", "ERR_EMPTY_RESPONSE"],
        ["/reset", "ERR_CONNECTION_RESET"],
      ]) {
        const obs = await observe(
          browser,
          `${base}${path}`,
          `${base}/ok`,
          fast,
        );
        expect(obs, path).toMatchObject({
          status: 200,
          fallbackUsed: true,
          netError: code,
        });
      }
    });

    it("falls back after a load timeout with no response", async () => {
      const obs = await observe(browser, `${base}/never`, `${base}/ok`, {
        settleMs: 300,
        loadTimeoutMs: 1_500,
        evalTimeoutMs: 5_000,
      });
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        netError: null,
        primaryNetError: null,
        fallbackNetError: null,
      });
    });

    it("rejects on rule 1 when the fallback also gets no response", async () => {
      const obs = await observe(browser, `${tlsBase}/`, `${closedBase}/`, fast);
      expect(obs).toMatchObject({
        finalUrl: null,
        status: null,
        fallbackUsed: true,
        netError: "ERR_CONNECTION_REFUSED",
        primaryNetError: "ERR_SSL_PROTOCOL_ERROR",
        fallbackNetError: "ERR_CONNECTION_REFUSED",
        loadIssue: null,
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "reject", rule: 1 });
    });

    it("rejects a www.-prefixed domain on rule 1 without a fallback", async () => {
      const { primary, fallback } = urlsFor("www.fixture.test");
      expect(primary).toBe("https://www.fixture.test/");
      const obs = await observe(browser, `${tlsBase}/`, fallback, fast);
      expect(obs).toMatchObject({
        status: null,
        fallbackUsed: false,
        netError: "ERR_SSL_PROTOCOL_ERROR",
        loadIssue: null,
      });
      expect(judge("www.fixture.test", obs)).toEqual({
        result: "reject",
        rule: 1,
      });
    });

    it("judges a document whose load never fires as it stands at the timeout + settle, without a fallback (Amendment 2 §1)", async () => {
      const t0 = Date.now();
      const obs = await observe(browser, `${base}/hang`, `${base}/ok`, {
        settleMs: 300,
        loadTimeoutMs: 1_500,
        evalTimeoutMs: 5_000,
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_800);
      expect(obs).toMatchObject({
        finalUrl: `${base}/hang`,
        status: 200,
        contentType: "text/html; charset=utf-8",
        documentContentType: "text/html",
        fallbackUsed: false,
        primaryNetError: null,
        loadTimedOut: true,
        loadIssue: null,
        page: { botWall: false, focusable: 1, rta: false },
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "accept" });
    });

    it("rejects on rule 1 when the in-page read doesn't finish in time, and records the response (Amendment 2 §2)", async () => {
      const obs = await observe(browser, `${base}/spin`, `${base}/ok`, {
        ...fast,
        evalTimeoutMs: 1_000,
      });
      expect(obs).toMatchObject({
        finalUrl: `${base}/spin`,
        status: 200,
        contentType: "text/html; charset=utf-8",
        fallbackUsed: false,
        readTimedOut: true,
        loadIssue: null,
        page: null,
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "reject", rule: 1 });
    });

    it("treats a redirect loop as no HTTP response: one www fallback, then rule 1 (Amendment 2 §5)", async () => {
      const fell = await observe(browser, `${base}/loop`, `${base}/ok`, fast);
      expect(fell).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        netError: "ERR_TOO_MANY_REDIRECTS",
        primaryNetError: "ERR_TOO_MANY_REDIRECTS",
        fallbackNetError: null,
      });
      expect(judge("fixture.test", fell)).toEqual({ result: "accept" });
      const both = await observe(browser, `${base}/loop`, `${base}/loop`, fast);
      expect(both).toMatchObject({
        finalUrl: null,
        status: null,
        fallbackUsed: true,
        primaryNetError: "ERR_TOO_MANY_REDIRECTS",
        fallbackNetError: "ERR_TOO_MANY_REDIRECTS",
        loadIssue: null,
      });
      expect(judge("fixture.test", both)).toEqual({
        result: "reject",
        rule: 1,
      });
    });

    it("treats an aborted navigation (a 204) as no HTTP response and falls back (Amendment 2 §5)", async () => {
      const obs = await observe(browser, `${base}/204`, `${base}/ok`, fast);
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        primaryNetError: "ERR_ABORTED",
      });
    });

    it("falls back when a document answered but a later navigation left no final document (Amendment 2 §5)", async () => {
      const obs = await observe(
        browser,
        `${base}/js-to-dead`,
        `${base}/ok`,
        fast,
      );
      expect(obs).toMatchObject({
        finalUrl: `${base}/ok`,
        status: 200,
        fallbackUsed: true,
        primaryNetError: "ERR_CONNECTION_REFUSED",
        loadIssue: null,
      });
      expect(judge("fixture.test", obs)).toEqual({ result: "accept" });
    });
  },
);
