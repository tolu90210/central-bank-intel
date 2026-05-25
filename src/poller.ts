import cron from "node-cron";
import { FEED_FETCHERS } from "./feeds/index.js";
import { classifyDocument, computeDrift } from "./classifier.js";
import {
  upsertDocument, setIntelligence, setDeadLetter, logDeadLetter,
  getLatestByType, getBaseline, computeAndStoreBaseline,
} from "./db.js";
import type { BankId, Intelligence } from "./types.js";

const BANKS: BankId[] = ["fed", "ecb", "boe", "boj"];

export async function pollBank(bank: BankId): Promise<void> {
  console.log(`[poll] ${bank} started at ${new Date().toISOString()}`);
  let fetched: Awaited<ReturnType<typeof FEED_FETCHERS.fed>>;
  try {
    fetched = await FEED_FETCHERS[bank]();
  } catch (e) {
    console.error(`[poll] ${bank} feed fetch failed:`, e);
    return;
  }

  for (const doc of fetched) {
    if (doc.fetch_error) {
      const id = upsertDocument(doc);
      setDeadLetter(id, doc.fetch_error);
      logDeadLetter(doc.guid, doc.bank, doc.url, doc.fetch_error);
      console.warn(`[dead-letter] ${bank} ${doc.guid}: ${doc.fetch_error}`);
      continue;
    }

    const id = upsertDocument(doc);

    try {
      // Pure lexicon — synchronous, zero API cost
      const partial = classifyDocument(doc.bank, doc.doc_type, doc.title, doc.text);
      const intel: Intelligence = { ...partial, tone_vs_baseline: null, drift_from_previous: null };

      // Tone vs 90-day baseline
      const baseline = getBaseline(bank);
      if (baseline) {
        const netScore = intel.hawkish_score - intel.dovish_score;
        intel.tone_vs_baseline = Math.round(netScore - baseline.avg_net_score);
      }

      // Drift from previous same doc type (TF-IDF cosine, also free)
      const [prev] = getLatestByType(bank, doc.doc_type, 1);
      if (prev?.text && prev.text.length > 100) {
        intel.drift_from_previous = computeDrift(prev.text, doc.text);
      }

      setIntelligence(id, intel);
      console.log(`[classified] ${bank} "${doc.title.slice(0, 60)}" stance=${intel.net_stance} hawk=${intel.hawkish_score} dov=${intel.dovish_score}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setDeadLetter(id, `classification_failed: ${reason}`);
      logDeadLetter(doc.guid, bank, doc.url, `classification: ${reason}`);
      console.error(`[dead-letter] classification failed for ${doc.guid}:`, reason);
    }
  }

  computeAndStoreBaseline(bank);
}

export async function pollAll(): Promise<void> {
  for (const bank of BANKS) {
    await pollBank(bank).catch(e => console.error(`[poll] ${bank} unhandled:`, e));
  }
}

export function startPoller(): void {
  cron.schedule("*/5 * * * *", () => {
    pollAll().catch(e => console.error("[cron] unhandled:", e));
  });
  console.log("[poller] started — 5-minute interval");
  pollAll().catch(e => console.error("[poller] initial poll failed:", e));
}
