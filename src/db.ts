import { DatabaseSync } from "node:sqlite";
import type { StoredDocument, RawDocument, Intelligence, BankBaseline, BankId, DocType } from "./types.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? `${process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "./data"}/central_bank.db`;
let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      guid          TEXT UNIQUE NOT NULL,
      bank          TEXT NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      published     TEXT NOT NULL,
      doc_type      TEXT NOT NULL,
      text          TEXT NOT NULL,
      fetch_error   TEXT,
      intelligence  TEXT,
      dead_letter   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bank_published ON documents(bank, published);
    CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(bank, doc_type, published);

    CREATE TABLE IF NOT EXISTS baselines (
      bank          TEXT PRIMARY KEY,
      avg_net_score REAL NOT NULL,
      doc_count     INTEGER NOT NULL,
      computed_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dead_letters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guid        TEXT NOT NULL,
      bank        TEXT NOT NULL,
      url         TEXT NOT NULL,
      reason      TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return _db;
}

export function upsertDocument(doc: RawDocument): number {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM documents WHERE guid = ?").get(doc.guid) as { id: number } | undefined;
  if (existing) return existing.id;
  const r = db.prepare(`
    INSERT INTO documents (guid, bank, title, url, published, doc_type, text, fetch_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(doc.guid, doc.bank, doc.title, doc.url, doc.published, doc.doc_type, doc.text, doc.fetch_error);
  return Number(r.lastInsertRowid);
}

export function setIntelligence(id: number, intel: Intelligence): void {
  getDb().prepare("UPDATE documents SET intelligence = ? WHERE id = ?")
    .run(JSON.stringify(intel), id);
}

export function setDeadLetter(id: number, reason: string): void {
  getDb().prepare("UPDATE documents SET dead_letter = ? WHERE id = ?").run(reason, id);
}

export function logDeadLetter(guid: string, bank: BankId, url: string, reason: string): void {
  getDb().prepare("INSERT INTO dead_letters (guid, bank, url, reason) VALUES (?, ?, ?, ?)")
    .run(guid, bank, url, reason);
}

export function getRecentDocuments(bank?: BankId, limit = 20): StoredDocument[] {
  const db = getDb();
  const q = bank
    ? db.prepare("SELECT * FROM documents WHERE bank = ? ORDER BY published DESC LIMIT ?").all(bank, limit)
    : db.prepare("SELECT * FROM documents ORDER BY published DESC LIMIT ?").all(limit);
  return (q as any[]).map(deserialize);
}

export function getLatestByType(bank: BankId, docType: DocType, limit = 2): StoredDocument[] {
  return (getDb().prepare(
    "SELECT * FROM documents WHERE bank = ? AND doc_type = ? AND intelligence IS NOT NULL ORDER BY published DESC LIMIT ?"
  ).all(bank, docType, limit) as any[]).map(deserialize);
}

export function getBaseline(bank: BankId): BankBaseline | null {
  return getDb().prepare("SELECT * FROM baselines WHERE bank = ?").get(bank) as unknown as BankBaseline | null;
}

export function upsertBaseline(b: BankBaseline): void {
  getDb().prepare(`
    INSERT INTO baselines (bank, avg_net_score, doc_count, computed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bank) DO UPDATE SET avg_net_score=excluded.avg_net_score,
      doc_count=excluded.doc_count, computed_at=excluded.computed_at
  `).run(b.bank, b.avg_net_score, b.doc_count, b.computed_at);
}

export function computeAndStoreBaseline(bank: BankId): void {
  const rows = getDb().prepare(`
    SELECT intelligence FROM documents
    WHERE bank = ? AND intelligence IS NOT NULL
      AND published >= datetime('now', '-90 days')
  `).all(bank) as { intelligence: string }[];

  if (rows.length === 0) return;
  const scores = rows.map(r => {
    const i: Intelligence = JSON.parse(r.intelligence);
    return i.hawkish_score - i.dovish_score;
  });
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  upsertBaseline({ bank, avg_net_score: avg, doc_count: rows.length, computed_at: new Date().toISOString() });
}

function deserialize(row: any): StoredDocument {
  return {
    ...row,
    intelligence: row.intelligence ? JSON.parse(row.intelligence) : null,
  };
}
