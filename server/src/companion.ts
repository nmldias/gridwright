// The companion's working model of a situation, kept per document: source-backed facts, the
// objective and its constraints, exclusions, hypotheses, contradictions, decisions with the
// conditions behind them, open questions, expectations (what should have happened), each with
// where it came from, the period it describes, when it arrived and whether a person stated it, an
// agent proposed it or a check observed it; a registry of watches (what is watched, why, under
// which conditions, with what authority); cheap deterministic checks that run on every change and
// on a timer; one evolving issue per watch; an understanding that answers what we are working
// toward, what matters now and what the next useful move is; and a brief of what has changed.
// The model is asked only to interpret an attention-level issue or to run a bounded
// investigation, and its words are stored as its own, beside the evidence.
//
// More information increases the companion's understanding, not its authority: nothing here grants
// access, and an instruction inside a record is data, not an instruction to anyone.
//
// The model is split by responsibility: state (what is kept and how), context (records,
// decisions, scope, the understanding, the brief), monitoring (watches, freshness, checks,
// suggestions, scheduling), relations (periods and the graph) and investigations (runs and the
// investigation records). This module is the one import the rest of the server uses.

export * from './companion/state.js';
export * from './companion/context.js';
export * from './companion/monitoring.js';
export * from './companion/relations.js';
export * from './companion/investigations.js';
