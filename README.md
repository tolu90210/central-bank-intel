# central-bank-intel-mcp

Automated monetary policy intelligence for the Federal Reserve, ECB, Bank of England, and Bank of Japan. Polls official RSS feeds and pages every 5 minutes, classifies each document with a deterministic hawkish/dovish lexicon, detects forward guidance signals, and computes tone drift — all without an LLM API call. All MCP tools respond from pre-classified SQLite data at sub-100ms latency.

## What it does

Every 5 minutes the background poller fetches new documents from four official central bank sources, strips HTML, stores the full text, and classifies each document synchronously using a weighted Loughran-McDonald inspired lexicon. The classification pipeline produces:

- **Hawkish and dovish scores** (0–100) from weighted term frequency normalized to document length
- **Net stance**: hawkish / dovish / neutral / mixed
- **Forward guidance**: tightening_bias / easing_bias / on_hold / data_dependent / none_detected (via 9 regex patterns)
- **Key themes**: top lexicon hit terms + top TF-IDF bigrams from the document text
- **Tone vs 90-day baseline**: signed delta from the rolling average net score for that bank
- **Drift from previous**: TF-IDF cosine distance from the previous document of the same type, 0–100

No LLM calls. No paid APIs. All classification is deterministic and synchronous.

## Data Sources

| Bank | Sources | Doc types polled |
|---|---|---|
| Federal Reserve | `federalreserve.gov/feeds/press_monetary.xml` + `federalreserve.gov/feeds/speeches.xml` | statements, speeches, minutes |
| ECB | `ecb.europa.eu/rss/press.html` | press releases, speeches, interviews |
| Bank of England | `bankofengland.co.uk/rss/speeches` + MPC summary pages (constructed URL per month) | speeches, minutes |
| Bank of Japan | `boj.or.jp/en/rss/whatsnew.xml` (filtered to policy terms) | statements, speeches, outlook reports |

All sources are official central bank publications. No third-party data vendors.

## MCP Tools

### `get_central_bank_intelligence`
Latest classified documents for one or all banks.

**Input:**
```json
{ "bank": "fed" | "ecb" | "boe" | "boj" | "all", "doc_type": "statement" | "minutes" | "speech" | "any", "limit": 5 }
```

**Output per document:**
```json
{
  "bank": "fed",
  "title": "FOMC Statement — May 2026",
  "published": "2026-05-07T18:00:00.000Z",
  "doc_type": "statement",
  "intelligence": {
    "hawkish_score": 42,
    "dovish_score": 18,
    "net_stance": "hawkish",
    "forward_guidance": "data_dependent",
    "key_themes": ["inflation persistence", "labor market", "price stability"],
    "tone_vs_baseline": 8,
    "drift_from_previous": 23,
    "summary": "Federal Reserve statement conveys a hawkish tone..."
  }
}
```

### `compare_bank_stances`
Side-by-side comparison of all four banks. Selects the highest-priority document per bank (statement > minutes > speech > testimony > report). Flags `cross_bank_divergence: true` when more than two distinct stances are detected.

**Input:** `{}` (no parameters)

### `search_bank_documents`
Full-text search across the stored document corpus using SQLite LIKE queries. Returns matched documents with intelligence scores.

**Input:** `{ "query": "inflation persistence", "bank": "all", "limit": 5 }`

### `get_pipeline_health`
Dead letter queue contents, document counts per bank (total / classified / dead), and current timestamp. Use to verify the poller is running and catch feed format drift.

**Input:** `{}` (no parameters)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | Server port |
| `DB_PATH` | No | Path to SQLite database file. Defaults to `./data/central_bank.db` in the working directory |

No external API keys required. All four data sources are free and open.

## Running Locally

```bash
npm install
npm run dev
```

On first start the poller runs immediately and populates the database. Intelligence scores appear within 30–60 seconds depending on feed size.

```bash
# Check current Fed stance
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_central_bank_intelligence","arguments":{"bank":"fed","doc_type":"statement","limit":1}}}' \
  | jq '.result.structuredContent.documents[0].intelligence'

# Cross-bank comparison
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"compare_bank_stances","arguments":{}}}' \
  | jq '.result.structuredContent.comparison'
```

## Deployment (Railway)

```bash
# Push to GitHub, connect repo in Railway
# Optional: add a Railway volume and set DB_PATH=/data/central_bank.db
# This persists the SQLite database across restarts
# Without a volume, the DB resets on each deploy (poller re-populates in ~60 seconds)
```

## Classification Architecture

**Lexicon scoring:** Weighted substring matching against a central bank-specific lexicon. Hawkish and dovish terms each have weights 1 (general signal), 2 (strong signal), or 3 (explicit policy signal — e.g. "rate hike", "above target"). Scores are normalized by word count and capped at 100.

**Forward guidance:** 9 regex patterns checked in order against the full document text. First match wins. Patterns cover: further rate increase, further rate cut, hold rates, rate will remain, data-dependent language.

**Semantic drift:** TF-IDF cosine similarity between the current document and the previous document of the same type from the same bank. Drift 0 = identical vocabulary distribution; drift 100 = no shared vocabulary. Scores above 40 typically indicate meaningful policy shift.

**90-day baseline:** Recomputed after every poll cycle as the rolling average of (hawkish_score - dovish_score) across all documents for that bank from the last 90 days. Tone vs baseline is the signed delta: positive = more hawkish than the bank's own recent average.

## Dead Letter Queue

Documents that fail HTML fetch (403, timeout, PDF format) or classification are stored in the dead_letters table with reason codes. Common causes: BoJ PDFs (skipped by design), occasional BoE format drift, ECB documents behind redirects. Use `get_pipeline_health` to surface recent dead letters.

## Transport

The server exposes both SSE (GET /mcp) and stateless HTTP POST (POST /mcp) using Express and the @modelcontextprotocol/sdk SSEServerTransport. CTX context middleware is applied at /mcp via @ctxprotocol/sdk.
