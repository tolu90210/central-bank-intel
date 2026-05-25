// ── Shared sub-schemas ────────────────────────────────────────────────────

const INTELLIGENCE_SCHEMA = {
  type: "object",
  description: "Lexicon-based classification output for one document",
  properties: {
    hawkish_score:       { type: "number",           description: "Weighted hawkish term frequency, normalized to document length. 0–100." },
    dovish_score:        { type: "number",           description: "Weighted dovish term frequency, normalized to document length. 0–100." },
    net_stance:          { type: "string",           enum: ["hawkish", "dovish", "neutral", "mixed"], description: "hawkish if net>10, dovish if net<-10, mixed if both scores≥50, neutral otherwise." },
    forward_guidance:    { type: "string",           enum: ["tightening_bias", "easing_bias", "on_hold", "data_dependent", "none_detected"] },
    key_themes:          { type: "array",            items: { type: "string" }, description: "Top bigrams and lexicon hit terms from document text. Up to 5." },
    tone_vs_baseline:    { type: ["number", "null"], description: "Signed delta: current net score minus 90-day rolling average for this bank. Positive = more hawkish than baseline. Null until baseline window accumulates." },
    drift_from_previous: { type: ["number", "null"], description: "TF-IDF cosine distance from previous same doc_type for this bank. 0 = identical vocabulary, 100 = no shared vocabulary. Null if no prior document exists." },
    summary:             { type: "string",           description: "One-sentence plain-language verdict: bank name, doc type, stance, key evidence, forward guidance." },
  },
  required: ["hawkish_score", "dovish_score", "net_stance", "forward_guidance", "key_themes", "tone_vs_baseline", "drift_from_previous", "summary"],
};

const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    id:           { type: "number",           description: "Internal document ID (SQLite rowid)" },
    bank:         { type: "string",           enum: ["fed", "ecb", "boe", "boj"] },
    title:        { type: "string" },
    url:          { type: "string",           description: "Source URL of the original document" },
    published:    { type: "string",           description: "ISO 8601 publication timestamp from the RSS feed" },
    doc_type:     { type: "string",           enum: ["statement", "minutes", "speech", "testimony", "report", "other"] },
    intelligence: {
      // Cannot use anyOf/oneOf at root — express nullability inline
      type: ["object", "null"],
      description: "Classification output. Null if document failed classification (see dead_letter).",
      properties: INTELLIGENCE_SCHEMA.properties,
    },
    dead_letter:  { type: ["string", "null"], description: "Error reason if fetch or classification failed. Null on success." },
  },
  required: ["id", "bank", "title", "url", "published", "doc_type", "intelligence", "dead_letter"],
};

const BASELINE_SCHEMA = {
  type: "object",
  description: "90-day rolling average net score for one bank",
  properties: {
    bank:          { type: "string", enum: ["fed", "ecb", "boe", "boj"] },
    avg_net_score: { type: "number", description: "Average (hawkish_score - dovish_score) across all documents in the last 90 days" },
    doc_count:     { type: "number" },
    computed_at:   { type: "string", description: "ISO 8601 timestamp of last baseline computation" },
  },
  required: ["bank", "avg_net_score", "doc_count", "computed_at"],
};

// Per-bank entry in compare_bank_stances — dynamic keys so use additionalProperties
const BANK_STANCE_SCHEMA = {
  type: "object",
  description: "Latest stance for one bank. All fields null if no classified documents exist yet (status='no_data').",
  properties: {
    latest_doc:             { type: ["string", "null"], description: "Title of the most recent classified document" },
    published:              { type: ["string", "null"], description: "ISO 8601 publication timestamp" },
    doc_type:               { type: ["string", "null"], enum: ["statement", "minutes", "speech", "testimony", "report", "other", null] },
    net_stance:             { type: ["string", "null"], enum: ["hawkish", "dovish", "neutral", "mixed", null] },
    hawkish_score:          { type: ["number", "null"] },
    dovish_score:           { type: ["number", "null"] },
    forward_guidance:       { type: ["string", "null"], enum: ["tightening_bias", "easing_bias", "on_hold", "data_dependent", "none_detected", null] },
    tone_vs_baseline:       { type: ["number", "null"] },
    key_themes:             { type: "array", items: { type: "string" } },
    baseline_avg_net_score: { type: ["number", "null"] },
    status:                 { type: ["string", "null"], description: "no_data if bank has no classified documents yet, otherwise null" },
  },
  required: ["latest_doc", "published", "doc_type", "net_stance", "hawkish_score", "dovish_score", "forward_guidance", "tone_vs_baseline", "key_themes", "baseline_avg_net_score"],
};

// ── Tool definitions ───────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "get_central_bank_intelligence",
    description: "Returns the latest classified central bank communication intelligence for one or all banks. Includes hawkish/dovish scores, net stance, forward guidance signal, key themes, tone vs 90-day baseline, and drift from previous same document type.",
    inputSchema: {
      type: "object",
      properties: {
        bank:     { type: "string", enum: ["fed", "ecb", "boe", "boj", "all"], default: "all", description: "Which central bank to query" },
        doc_type: { type: "string", enum: ["statement", "minutes", "speech", "testimony", "report", "other", "any"], default: "any" },
        limit:    { type: "number", minimum: 1, maximum: 20, default: 5 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "Echo of input parameters",
          properties: {
            bank:     { type: "string" },
            doc_type: { type: "string" },
            limit:    { type: "number" },
          },
          required: ["bank", "doc_type", "limit"],
        },
        documents: {
          type: "array",
          description: "Latest classified documents matching the query, sorted by published descending",
          items: DOCUMENT_SCHEMA,
        },
        baselines: {
          type: "array",
          description: "90-day baseline scores for the queried bank(s). Empty if baseline window has not yet accumulated.",
          items: BASELINE_SCHEMA,
        },
      },
      required: ["query", "documents", "baselines"],
    },
  },

  {
    name: "compare_bank_stances",
    description: "Compares current monetary policy stance across all four central banks (Fed, ECB, BoE, BoJ) side by side. Returns divergence analysis useful for FX positioning and macro research.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        comparison: {
          type: "object",
          description: "Keyed by bank ID: fed, ecb, boe, boj. Each value is the stance from the most recent classified document for that bank, prioritised by doc_type: statement > minutes > speech > testimony > report > other.",
          additionalProperties: BANK_STANCE_SCHEMA,
        },
        cross_bank_divergence: {
          type: "boolean",
          description: "True when more than two distinct net_stance values are detected simultaneously across the four banks. Indicates a macro divergence regime.",
        },
        generated_at: {
          type: "string",
          description: "ISO 8601 timestamp of this response",
        },
      },
      required: ["comparison", "cross_bank_divergence", "generated_at"],
    },
  },

  {
    name: "search_bank_documents",
    description: "Search stored central bank documents by keyword in title or text. Returns matched documents with intelligence scores.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 100 },
        bank:  { type: "string", enum: ["fed", "ecb", "boe", "boj", "all"], default: "all" },
        limit: { type: "number", minimum: 1, maximum: 10, default: 5 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search keyword that was queried",
        },
        matches: {
          type: "array",
          description: "Documents whose title or text contains the query string, sorted by published descending. Only documents with successful intelligence classification are returned.",
          items: DOCUMENT_SCHEMA,
        },
      },
      required: ["query", "matches"],
    },
  },

  {
    name: "get_pipeline_health",
    description: "Returns pipeline health: dead letter queue contents, document counts per bank, and last successful poll time. Use to diagnose format drift or feed failures.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        document_counts: {
          type: "array",
          description: "Per-bank document totals from the SQLite store",
          items: {
            type: "object",
            properties: {
              bank:       { type: "string", enum: ["fed", "ecb", "boe", "boj"] },
              total:      { type: "number", description: "Total documents stored for this bank" },
              classified: { type: "number", description: "Documents with successful intelligence classification" },
              dead:       { type: "number", description: "Documents in the dead letter queue (fetch or classification failed)" },
            },
            required: ["bank", "total", "classified", "dead"],
          },
        },
        recent_dead_letters: {
          type: "array",
          description: "Last 10 dead letter queue entries, sorted by occurred_at descending",
          items: {
            type: "object",
            properties: {
              bank:        { type: "string" },
              url:         { type: "string",  description: "URL of the document that failed" },
              reason:      { type: "string",  description: "Failure reason — HTTP error code, timeout, PDF skip, or classification error" },
              occurred_at: { type: "string",  description: "ISO 8601 timestamp" },
            },
            required: ["bank", "url", "reason", "occurred_at"],
          },
        },
        checked_at: {
          type: "string",
          description: "ISO 8601 timestamp of this health check",
        },
      },
      required: ["document_counts", "recent_dead_letters", "checked_at"],
    },
  },
];
