import { HAWKISH, DOVISH, FORWARD_GUIDANCE_PATTERNS, STOPWORDS } from "./lexicon.js";
import type { Intelligence, ForwardGuidance, Stance, BankId, DocType } from "./types.js";

interface TermHit { term: string; weight: number; count: number }

function scoreText(text: string, lexicon: Record<string, number>): { score: number; hits: TermHit[] } {
  const lower = text.toLowerCase();
  const wordCount = Math.max(lower.split(/\s+/).length, 1);
  const hits: TermHit[] = [];
  for (const [term, weight] of Object.entries(lexicon)) {
    let count = 0, pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) { count++; pos += term.length; }
    if (count > 0) hits.push({ term, weight, count });
  }
  const raw = hits.reduce((sum, h) => sum + h.weight * h.count, 0);
  return { score: Math.min(Math.round((raw / wordCount) * 1000 * 4), 100), hits };
}

function detectForwardGuidance(text: string): ForwardGuidance {
  for (const { pattern, signal } of FORWARD_GUIDANCE_PATTERNS) {
    if (pattern.test(text)) return signal;
  }
  return "none_detected";
}

// Stems that appear in the lexicon for substring matching but shouldn't surface as themes
const STEM_BLACKLIST = new Set([
  "vulnerab", "deteriorat", "ease", "easing", "tighten", "tightening",
  "support", "inflation", "determined", "vigilant", "resilient", "gradual",
]);

// Navigation/boilerplate bigrams to suppress
const BOILERPLATE = new Set([
  "page federal", "reserve system", "federal reserve", "research papers",
  "speeches statements", "papers reports", "reports speeches", "documents links",
  "press release", "skip navigation", "related information",
  "accept cookies", "cookie policy", "working paper", "staff working",
  "publication working", "during pandemic", "performance during",
  "governors federal", "oath office", "office chairman",
  "minutes federal", "federal open", "open market", "united states",
  "governing council", "market infrastructure", "triennial survey",
  "developments characteristics", "characteristics japan",
  "secure websites", "search submit", "toggle button", "reserve minutes",
  "council object", "european banking", "analysis based", "based triennial",
  "market analysis", "japan market", "range federal", "federal funds",
  "markets department", "review developments", "survey japan",
  "credit terms", "terms conditions", "securities financing", "price terms",
]);

function extractThemes(text: string, hawkishHits: TermHit[], dovishHits: TermHit[]): string[] {
  const themes: string[] = [];
  const topHawkish = [...hawkishHits].sort((a, b) => b.weight * b.count - a.weight * a.count)
    .filter(h => !STEM_BLACKLIST.has(h.term)).slice(0, 3);
  const topDovish  = [...dovishHits].sort((a, b) => b.weight * b.count - a.weight * a.count)
    .filter(h => !STEM_BLACKLIST.has(h.term)).slice(0, 3);
  for (const h of [...topHawkish, ...topDovish]) themes.push(h.term);

  const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
  const freq: Record<string, number> = {};
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (!STOPWORDS.has(words[i]) && !STOPWORDS.has(words[i + 1]))
      freq[bigram] = (freq[bigram] ?? 0) + 1;
  }
  const topBigrams = Object.entries(freq).sort((a, b) => b[1] - a[1])
    .filter(([t]) => !BOILERPLATE.has(t))
    .slice(0, 4).map(([t]) => t);
  return [...new Set([...themes, ...topBigrams])].slice(0, 5);
}

function buildSummary(bank: BankId, docType: DocType, netStance: Stance, hawkScore: number, dovScore: number, guidance: ForwardGuidance, hawkHits: TermHit[], dovHits: TermHit[]): string {
  const bankName: Record<BankId, string> = { fed: "Federal Reserve", ecb: "ECB", boe: "Bank of England", boj: "Bank of Japan" };
  const guidanceDesc: Record<ForwardGuidance, string> = {
    tightening_bias: "Forward guidance signals further tightening.",
    easing_bias: "Forward guidance signals further easing.",
    on_hold: "Forward guidance signals rates on hold.",
    data_dependent: "Forward guidance is explicitly data-dependent.",
    none_detected: "No explicit forward guidance detected.",
  };
  const topHawk = hawkHits.slice(0, 2).map(h => `"${h.term}"`).join(", ");
  const topDov  = dovHits.slice(0, 2).map(h => `"${h.term}"`).join(", ");
  const evidence = [topHawk && `hawkish signals: ${topHawk}`, topDov && `dovish signals: ${topDov}`].filter(Boolean).join("; ") || "no dominant signals";
  return `${bankName[bank]} ${docType} conveys a ${netStance} tone (hawkish: ${hawkScore}, dovish: ${dovScore}). Key evidence — ${evidence}. ${guidanceDesc[guidance]}`;
}

// TF-IDF cosine similarity for drift detection
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
}
function tfidfVector(tokens: string[], vocab: string[]): number[] {
  const freq: Record<string, number> = {};
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
  return vocab.map(term => (freq[term] ?? 0) / tokens.length);
}
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return (magA === 0 || magB === 0) ? 0 : dot / (magA * magB);
}
export function computeDrift(textA: string, textB: string): number {
  const tokensA = tokenize(textA), tokensB = tokenize(textB);
  const vocab = [...new Set([...tokensA, ...tokensB])];
  return Math.round((1 - cosineSimilarity(tfidfVector(tokensA, vocab), tfidfVector(tokensB, vocab))) * 100);
}

export function classifyDocument(bank: BankId, docType: DocType, title: string, text: string): Omit<Intelligence, "tone_vs_baseline" | "drift_from_previous"> {
  const { score: hawkishScore, hits: hawkHits } = scoreText(text, HAWKISH);
  const { score: dovishScore,  hits: dovHits  } = scoreText(text, DOVISH);
  const netScore = hawkishScore - dovishScore;
  const netStance: Stance = hawkishScore >= 50 && dovishScore >= 50 ? "mixed"
    : netScore > 10 ? "hawkish" : netScore < -10 ? "dovish" : "neutral";
  return {
    hawkish_score:    hawkishScore,
    dovish_score:     dovishScore,
    net_stance:       netStance,
    forward_guidance: detectForwardGuidance(text),
    key_themes:       extractThemes(text, hawkHits, dovHits),
    summary:          buildSummary(bank, docType, netStance, hawkishScore, dovishScore, detectForwardGuidance(text), hawkHits, dovHits),
  };
}
