export type BankId = "fed" | "ecb" | "boe" | "boj";
export type DocType = "statement" | "minutes" | "speech" | "testimony" | "report" | "other";
export type Stance = "hawkish" | "dovish" | "neutral" | "mixed";
export type ForwardGuidance = "tightening_bias" | "easing_bias" | "on_hold" | "data_dependent" | "none_detected";

export interface RawDocument {
  guid:        string;
  bank:        BankId;
  title:       string;
  url:         string;
  published:   string; // ISO
  doc_type:    DocType;
  text:        string;
  fetch_error: string | null;
}

export interface Intelligence {
  hawkish_score:          number;       // 0–100
  dovish_score:           number;       // 0–100
  net_stance:             Stance;
  forward_guidance:       ForwardGuidance;
  key_themes:             string[];
  tone_vs_baseline:       number | null; // signed delta vs 90-day avg net_stance score, null if no baseline
  drift_from_previous:    number | null; // 0–100 semantic drift vs previous same doc_type, null if no prior
  summary:                string;
}

export interface StoredDocument extends RawDocument {
  id:            number;
  intelligence:  Intelligence | null;
  dead_letter:   string | null;        // error reason if classification failed
  created_at:    string;
}

export interface BankBaseline {
  bank:          BankId;
  avg_net_score: number;               // avg (hawkish_score - dovish_score) over last 90 days
  doc_count:     number;
  computed_at:   string;
}
