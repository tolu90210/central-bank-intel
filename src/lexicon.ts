// Loughran-McDonald inspired central bank lexicon
// Each term has a weight: 1 = standard signal, 2 = strong signal, 3 = explicit policy signal

export const HAWKISH: Record<string, number> = {
  // Rate / tightening intent
  "rate hike": 3, "rate increase": 3, "raise rates": 3, "raising rates": 3,
  "interest rate increase": 3, "tighten": 2, "tightening": 2, "restrictive": 2,
  "restriction": 1, "less accommodative": 2, "remove accommodation": 2,

  // Inflation concern
  "inflation": 1, "inflationary": 2, "price pressure": 2, "price pressures": 2,
  "above target": 3, "above our target": 3, "above the target": 3,
  "persistent inflation": 3, "inflation persistence": 3, "elevated inflation": 2,
  "inflation expectations": 1, "inflation risk": 2, "upside risk": 1,
  "overheat": 2, "overheating": 2, "wage growth": 1, "wage pressure": 2,

  // Labour / demand strength
  "strong labor": 1, "strong labour": 1, "tight labor": 2, "tight labour": 2,
  "robust demand": 1, "strong demand": 1, "resilient": 1,

  // Vigilance language
  "vigilant": 2, "vigilance": 2, "determined": 2, "resolute": 2, "committed to price": 2,
  "not yet at": 2, "further action": 2, "additional tightening": 3,
  "further tightening": 3, "remain firm": 2,
};

export const DOVISH: Record<string, number> = {
  // Rate / easing intent
  "rate cut": 3, "rate reduction": 3, "cut rates": 3, "cutting rates": 3,
  "lower rates": 2, "reduce rates": 2, "ease": 1, "easing": 2,
  "accommodative": 2, "accommodation": 1, "stimulus": 2, "stimulative": 2,

  // Growth / labour concern
  "slowdown": 2, "slowing growth": 2, "below trend": 2, "weak demand": 2,
  "downside risk": 2, "downside risks": 2, "uncertainty": 1, "uncertainties": 1,
  "fragile": 2, "vulnerab": 1, "headwind": 2, "headwinds": 2,
  "deteriorat": 1, "contraction": 2, "recessionary": 3, "recession risk": 3,

  // Inflation undershoot
  "below target": 3, "below our target": 3, "subdued inflation": 2,
  "low inflation": 2, "deflationary": 3, "disinflation": 2,

  // Support language
  "support": 1, "supportive": 1, "stand ready": 2, "if needed": 2,
  "prepared to act": 2, "additional support": 2, "further support": 2,
  "ample liquidity": 2, "favorable conditions": 1,

  // Pause / caution
  "pause": 1, "patient": 1, "cautious": 1, "gradual": 1, "measured": 1,
};

export const FORWARD_GUIDANCE_PATTERNS: Array<{
  pattern: RegExp;
  signal: "tightening_bias" | "easing_bias" | "on_hold" | "data_dependent";
}> = [
  // Explicit tightening
  { pattern: /further (rate )?increase|additional (rate )?hike|more tightening/i, signal: "tightening_bias" },
  { pattern: /not yet (done|finished|at)|still room to tighten/i, signal: "tightening_bias" },
  // Explicit easing
  { pattern: /prepared to (cut|lower|reduce)|ready to ease|will (cut|lower) rate/i, signal: "easing_bias" },
  { pattern: /further (rate )?cut|additional (rate )?reduction/i, signal: "easing_bias" },
  // On hold
  { pattern: /hold (rates?|policy)|keep rates? (unchanged|steady|stable)|maintain (the )?rate/i, signal: "on_hold" },
  { pattern: /no (immediate )?change|rate (will )?remain/i, signal: "on_hold" },
  // Data dependent
  { pattern: /data.{0,20}dependent|meeting.{0,10}meeting|monitor.{0,20}(data|development)/i, signal: "data_dependent" },
  { pattern: /depend(s|ing) on (the |incoming |economic )?data/i, signal: "data_dependent" },
  { pattern: /if (the )?(outlook|conditions?|data) (change|warrant|require)/i, signal: "data_dependent" },
];

// Common English + finance stopwords to exclude from theme extraction
export const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","is","was","are","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might","shall",
  "this","that","these","those","it","its","we","our","they","their","he","she",
  "which","who","what","when","where","how","also","any","all","such","more",
  "other","than","then","so","if","not","no","nor","yet","both","either",
  "bank","central","committee","board","policy","monetary","rate","rates",
  "percent","per","basis","point","points","year","month","quarter","meeting",
  "march","april","may","june","july","august","september","october","november","december",
  "january","february","2024","2025","2026","said","noted","stated","indicated",
]);
