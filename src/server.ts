import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";

import { TOOLS } from "./tools.js";
import {
  getRecentDocuments, getBaseline, getDb,
  computeAndStoreBaseline,
} from "./db.js";
import { startPoller } from "./poller.js";
import type { BankId, StoredDocument, DocType } from "./types.js";

const PORT = parseInt(process.env.PORT ?? "3000");

// ── Logger ────────────────────────────────────────────────────────────────

const log = {
  info:  (msg: string, meta?: object) => console.log( `[INFO]  ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn:  (msg: string, meta?: object) => console.warn( `[WARN]  ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg: string, meta?: object) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ""),
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDoc(doc: StoredDocument) {
  return {
    id:           doc.id,
    bank:         doc.bank,
    title:        doc.title,
    url:          doc.url,
    published:    doc.published,
    doc_type:     doc.doc_type,
    intelligence: doc.intelligence,
    dead_letter:  doc.dead_letter,
  };
}

// ── Tool handler ──────────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "get_central_bank_intelligence": {
      const bank     = (args.bank ?? "all") as string;
      const docType  = (args.doc_type ?? "any") as string;
      const limit    = (args.limit as number) ?? 5;
      const bankFilter = bank === "all" ? undefined : bank as BankId;

      let docs = getRecentDocuments(bankFilter, 50);
      if (docType !== "any") docs = docs.filter(d => d.doc_type === docType);
      docs = docs.filter(d => d.intelligence !== null).slice(0, limit);

      return {
        query: { bank, doc_type: docType, limit },
        documents: docs.map(formatDoc),
        baselines: bank === "all"
          ? (["fed", "ecb", "boe", "boj"] as BankId[]).map(b => getBaseline(b)).filter(Boolean)
          : [getBaseline(bank as BankId)].filter(Boolean),
      };
    }

    case "compare_bank_stances": {
      const banks: BankId[] = ["fed", "ecb", "boe", "boj"];
      const comparison: Record<string, unknown> = {};
      const POLICY_PRIORITY: DocType[] = ["statement", "minutes", "speech", "testimony", "report", "other"];

      for (const bank of banks) {
        const docs = getRecentDocuments(bank, 20).filter(d => d.intelligence !== null);
        // Prefer high-priority doc types; fall back to most recent if none found
        const latest = POLICY_PRIORITY.reduce<StoredDocument | null>((found, type) => {
          if (found) return found;
          return docs.find(d => d.doc_type === type) ?? null;
        }, null) ?? docs[0];
        const baseline = getBaseline(bank);
        comparison[bank] = latest ? {
          latest_doc:             latest.title,
          published:              latest.published,
          doc_type:               latest.doc_type,
          net_stance:             latest.intelligence!.net_stance,
          hawkish_score:          latest.intelligence!.hawkish_score,
          dovish_score:           latest.intelligence!.dovish_score,
          forward_guidance:       latest.intelligence!.forward_guidance,
          tone_vs_baseline:       latest.intelligence!.tone_vs_baseline,
          key_themes:             latest.intelligence!.key_themes,
          baseline_avg_net_score: baseline?.avg_net_score ?? null,
        } : { status: "no_data" };
      }

      const stances  = Object.values(comparison).map((v: any) => v.net_stance).filter(Boolean);
      const divergent = new Set(stances).size > 2;
      return { comparison, cross_bank_divergence: divergent, generated_at: new Date().toISOString() };
    }

    case "search_bank_documents": {
      const query  = args.query as string;
      const bank   = (args.bank ?? "all") as string;
      const limit  = (args.limit as number) ?? 5;
      const db     = getDb();
      const pattern = `%${query}%`;

      const rows = bank === "all"
        ? db.prepare("SELECT * FROM documents WHERE (title LIKE ? OR text LIKE ?) AND intelligence IS NOT NULL ORDER BY published DESC LIMIT ?").all(pattern, pattern, limit)
        : db.prepare("SELECT * FROM documents WHERE bank = ? AND (title LIKE ? OR text LIKE ?) AND intelligence IS NOT NULL ORDER BY published DESC LIMIT ?").all(bank, pattern, pattern, limit);

      const parsed = (rows as any[]).map(r => ({ ...r, intelligence: typeof r.intelligence === "string" ? JSON.parse(r.intelligence) : r.intelligence })) as StoredDocument[];
      return { query, matches: parsed.map(formatDoc) };
    }

    case "get_pipeline_health": {
      const db = getDb();
      const counts = db.prepare(
        "SELECT bank, COUNT(*) as total, SUM(CASE WHEN intelligence IS NOT NULL THEN 1 ELSE 0 END) as classified, SUM(CASE WHEN dead_letter IS NOT NULL THEN 1 ELSE 0 END) as dead FROM documents GROUP BY bank"
      ).all();
      const recentDead = db.prepare(
        "SELECT bank, url, reason, occurred_at FROM dead_letters ORDER BY occurred_at DESC LIMIT 10"
      ).all();
      return { document_counts: counts, recent_dead_letters: recentDead, checked_at: new Date().toISOString() };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────

function makeServer(): Server {
  const server = new Server(
    { name: "central-bank-intel", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info("tools/list");
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const t0 = Date.now();
    log.info("tool/call", { name });
    try {
      const result = await handleTool(name, args as Record<string, unknown>);
      log.info("tool/ok", { name, ms: Date.now() - t0 });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool/err", { name, ms: Date.now() - t0, message });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true, structuredContent: { error: message } };
    }
  });

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  log.info("request", { method: req.method, path: req.path, body_method: req.body?.method });
  next();
});

app.use("/mcp", createContextMiddleware());

// ── SSE sessions ──────────────────────────────────────────────────────────

const sessions = new Map<string, SSEServerTransport>();

app.get("/mcp", async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport("/mcp", res);
  const server    = makeServer();
  sessions.set(transport.sessionId, transport);
  res.on("close", () => {
    sessions.delete(transport.sessionId);
    log.info("sse/close", { activeSessions: sessions.size });
  });
  await server.connect(transport);
});

// ── Stateless POST handler ────────────────────────────────────────────────

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;

  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
    await transport.handlePostMessage(req, res, req.body);
    return;
  }

  const { method, id } = req.body ?? {};

  if (method === "initialize") {
    res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "central-bank-intel", version: "1.0.0" }, capabilities: { tools: { listChanged: false } } } });
    return;
  }
  if (method === "notifications/initialized") { log.info("notifications/initialized"); res.status(204).end(); return; }
  if (method === "notifications/cancelled")   { log.warn("tool/cancelled", { id }); res.json({ jsonrpc: "2.0", id, result: {} }); return; }

  if (method === "tools/list") {
    log.info("tools/list");
    res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = req.body?.params ?? {};
    const t0 = Date.now();
    log.info("tool/call", { name });
    try {
      const result = await handleTool(name as string, args as Record<string, unknown>);
      log.info("tool/ok", { name, ms: Date.now() - t0 });
      res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool/err", { name, ms: Date.now() - t0, message });
      res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true, structuredContent: { error: message } } });
    }
    return;
  }

  log.warn("unknown_method", { method });
  res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

// ── Health ────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "central-bank-intel-mcp", version: "1.0.0", activeSessions: sessions.size });
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log.info("listening", { port: PORT });
  startPoller();
});
