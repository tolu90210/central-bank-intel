import type { BankId, DocType, RawDocument } from "../types.js";

// ── Shared utilities ──────────────────────────────────────────────────────

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "CentralBankIntelMCP/1.0 (research; contact via CTX Protocol)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CentralBankIntelMCP/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf")) throw new Error("PDF document — skipping (dead letter)");
  return res.text();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<button[\s\S]*?<\/button>/gi, "")
    .replace(/<input[^>]*>/gi, "")
    .replace(/<select[\s\S]*?<\/select>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim()
    .slice(0, 12_000);
}

function parseItems(xml: string): Array<{ guid: string; title: string; link: string; pubDate: string }> {
  const items: Array<{ guid: string; title: string; link: string; pubDate: string }> = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
      return r.exec(block)?.[1]?.trim() ?? "";
    };
    const guid = get("guid") || get("link");
    const link = get("link");
    const title = get("title");
    const pubDate = get("pubDate");
    if (guid && link && title) items.push({ guid, title, link, pubDate });
  }
  return items;
}

function inferDocType(title: string): DocType {
  const t = title.toLowerCase();
  if (/\bminutes\b/.test(t)) return "minutes";
  if (/\bstatement\b|\bfomc\b/.test(t)) return "statement";
  if (/\bspeech\b|\bremarks\b|\baddress\b|\bperspectives?\b|\bopening\b/.test(t)) return "speech";
  if (/\btestimony\b|\bhearing\b/.test(t)) return "testimony";
  if (/\breport\b|\boutlook\b|\bsurvey\b|\bprojections?\b/.test(t)) return "report";
  return "other";
}

async function buildDocument(bank: BankId, item: ReturnType<typeof parseItems>[0]): Promise<RawDocument> {
  let text = "";
  let fetchError: string | null = null;
  try {
    const html = await fetchHtml(item.link);
    text = stripHtml(html);
    if (text.length < 100) throw new Error("Extracted text too short — possible format drift");
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }
  return {
    guid:        item.guid,
    bank,
    title:       item.title,
    url:         item.link,
    published:   item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    doc_type:    inferDocType(item.title),
    text,
    fetch_error: fetchError,
  };
}

// ── Per-bank fetchers ─────────────────────────────────────────────────────

export async function fetchFed(): Promise<RawDocument[]> {
  // Two feeds: monetary policy decisions + governor speeches
  const [monetaryXml, speechesXml] = await Promise.all([
    fetchXml("https://www.federalreserve.gov/feeds/press_monetary.xml"),
    fetchXml("https://www.federalreserve.gov/feeds/speeches.xml"),
  ]);

  const seen = new Set<string>();
  const items: ReturnType<typeof parseItems> = [];
  for (const item of [...parseItems(monetaryXml), ...parseItems(speechesXml)]) {
    if (!seen.has(item.guid)) { seen.add(item.guid); items.push(item); }
  }

  // Most recent 12 across both feeds
  return Promise.all(items.slice(0, 12).map(i => buildDocument("fed", i)));
}

export async function fetchEcb(): Promise<RawDocument[]> {
  // Single feed covers press releases, speeches, and interviews
  const xml = await fetchXml("https://www.ecb.europa.eu/rss/press.html");
  const items = parseItems(xml).slice(0, 12);
  return Promise.all(items.map(i => buildDocument("ecb", i)));
}

export async function fetchBoe(): Promise<RawDocument[]> {
  // Two sources: speeches RSS + latest MPC summary (no RSS exists for MPC decisions)
  const speechesPromise = fetchXml("https://www.bankofengland.co.uk/rss/speeches")
    .then(xml => parseItems(xml).slice(0, 10))
    .then(items => Promise.all(items.map(i => buildDocument("boe", i))))
    .catch(() => [] as RawDocument[]);

  // BoE MPC publishes 8 times/year. Construct URL for recent months and try them.
  const now = new Date();
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const candidates: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    candidates.push(`https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/${d.getFullYear()}/${months[d.getMonth()]}-${d.getFullYear()}`);
  }

  const mpcDocs = await Promise.all(candidates.map(async (url, i) => {
    try {
      const html = await fetchHtml(url);
      const text = stripHtml(html);
      if (text.length < 200) return null;
      const slug = url.split("/").pop() ?? "";
      const title = `Bank of England MPC Summary and Minutes — ${slug.replace(/-/g, " ")}`;
      // Approximate published date: 1st of the target month (most recent = index 0)
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return {
        guid:        url,
        bank:        "boe" as BankId,
        title,
        url,
        published:   d.toISOString(),
        doc_type:    "minutes" as DocType,
        text,
        fetch_error: null as string | null,
      };
    } catch { return null; }
  }));

  const speeches = await speechesPromise;
  const mpc = mpcDocs.filter((d): d is NonNullable<typeof d> => d !== null);
  return [...mpc, ...speeches].slice(0, 12);
}

export async function fetchBoj(): Promise<RawDocument[]> {
  const xml = await fetchXml("https://www.boj.or.jp/en/rss/whatsnew.xml");
  const POLICY_TERMS = /policy|statement|minutes|speech|outlook|review|assessment|governor|rate|decision/i;
  const items = parseItems(xml).filter(i => POLICY_TERMS.test(i.title)).slice(0, 10);
  return Promise.all(items.map(i => buildDocument("boj", i)));
}

export const FEED_FETCHERS: Record<BankId, () => Promise<RawDocument[]>> = {
  fed: fetchFed,
  ecb: fetchEcb,
  boe: fetchBoe,
  boj: fetchBoj,
};
