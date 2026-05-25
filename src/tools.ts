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
  },
  {
    name: "compare_bank_stances",
    description: "Compares current monetary policy stance across all four central banks (Fed, ECB, BoE, BoJ) side by side. Returns divergence analysis useful for FX positioning and macro research.",
    inputSchema: { type: "object", properties: {} },
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
  },
  {
    name: "get_pipeline_health",
    description: "Returns pipeline health: dead letter queue contents, document counts per bank, and last successful poll time. Use to diagnose format drift or feed failures.",
    inputSchema: { type: "object", properties: {} },
  },
];
