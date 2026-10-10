// The companion's input contracts, as schemas: what a record, a watch, an intake, a placement, a
// run or an investigation request may carry, checked once at the boundary (REST, MCP, the worker)
// before any service sees it. Version 1 — a change that breaks a client bumps CONTRACT_VERSION and
// the client reads it from /api/health.

import { z } from 'zod';

export const CONTRACT_VERSION = 1;

export const RecordKindSchema = z.enum(['fact', 'source', 'objective', 'constraint', 'hypothesis', 'contradiction', 'decision', 'exclusion', 'question', 'expectation', 'scenario']);

const text = (n: number) => z.string().max(n);
const optText = (n: number) => text(n).optional();
/** YYYY-MM-DD, YYYY-MM or an ISO week; anything else is refused rather than guessed */
export const PeriodSchema = z.string().regex(/^(\d{4}-\d{2}(-\d{2})?|W\d{1,2}|\d{8})$/, 'a period is YYYY-MM-DD, YYYY-MM or Wnn').max(40);
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'a date is YYYY-MM-DD').max(40);

export const ConditionSchema = z.union([z.string().max(400), z.object({ text: text(400), watch: optText(64) })]);
export const LinkSchema = z.object({ table: z.coerce.number().int().nonnegative().optional(), ref: optText(80) });
export const CoverageSchema = z.object({ rows: z.coerce.number().int().nonnegative(), identifiers: z.number().int().nonnegative().optional(), idColumn: optText(120), entity: optText(200) });

export const RecordInputSchema = z.object({
  kind: RecordKindSchema,
  text: text(4000),
  source: optText(200),
  period: optText(40),
  links: z.array(LinkSchema).max(50).optional(),
  bearing: optText(400),
  due: optText(40),
  match: optText(200),
  reviewBy: optText(40),
  why: optText(2000),
  conditions: z.array(ConditionSchema).max(20).optional(),
  private: z.boolean().optional(),
  derivative: z.boolean().optional(),
  key: optText(80),
  intake: optText(80),
  coverage: CoverageSchema.optional(),
  inferred: z.boolean().optional(),
  steer: z.boolean().optional(),
  client: optText(80),
});

export const RecordPatchSchema = z.object({
  text: optText(4000),
  status: z.enum(['confirmed', 'retired', 'stated', 'resolved']).optional(),
  period: optText(40),
  source: optText(200),
  kind: RecordKindSchema.optional(),
  bearing: optText(400),
  due: optText(40),
  match: optText(200),
  reviewBy: optText(40),
  why: optText(2000),
  conditions: z.array(ConditionSchema).max(20).optional(),
  private: z.boolean().optional(),
  derivative: z.boolean().optional(),
  resolution: optText(1000),
  expected: z.enum(['met', 'didnt', 'open']).optional(),
  inferred: z.boolean().optional(),
  client: optText(80),
});

export const WatchDefSchema = z.object({
  purpose: optText(200),
  scope: optText(400),
  formula: optText(2000),
  table: optText(120),
  kind: z.enum(['threshold', 'check', 'change', 'worsening']).optional(),
  op: z.enum(['>', '>=', '<', '<=', '=', '!=']).optional(),
  value: z.coerce.number().optional(),
  bad: z.enum(['up', 'down']).optional(),
  sustain: z.coerce.number().int().min(1).max(12).optional(),
  response: z.enum(['note', 'brief', 'case']).optional(),
  sources: z.array(text(120)).max(20).optional(),
  freshnessHours: z.coerce.number().positive().optional(),
  complement: optText(2000),
  client: optText(80),
});

export const WatchPatchSchema = z.object({ approve: z.boolean().optional(), def: WatchDefSchema.optional(), reason: optText(1000), client: optText(80) });

export const DismissSchema = z.object({ id: text(120), purpose: optText(200), reason: optText(1000), client: optText(80) });

export const IntakeRequestSchema = z.union([
  z.object({ inbox: text(200), client: optText(80) }),
  z.object({ connection: text(64), sql: text(20000), client: optText(80) }),
  z.object({ name: text(200).optional(), base64: z.string().optional(), text: z.string().optional(), client: optText(80) }),
]);

export const PlacementSchema = z.object({
  decisions: z.array(z.object({ set: optText(200), action: z.enum(['update', 'new', 'history', 'skip']), table: z.coerce.number().int().nonnegative().optional(), name: optText(120) })).max(50).default([]),
  period: optText(40),
  client: optText(80),
});

export const RunRequestSchema = z.object({ code: text(100_000), purpose: optText(200), investigation: optText(64), client: optText(80) });

export const InvestigateSchema = z.object({ question: optText(2000), issue: optText(64), thread: z.string().regex(/^[a-zA-Z0-9:_-]{1,80}$/).optional(), client: optText(80) });

export const ConversationSchema = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).passthrough()).max(400) });
