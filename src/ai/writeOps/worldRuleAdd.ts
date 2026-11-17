import { WriteOp, ToolContext } from '../types';
import {
  WorldRuleSchema,
  WorldRuleCategorySchema,
  WorldRuleSeveritySchema,
  WorldRule,
} from '../../storage/schemas';
import { z } from 'zod';

const worldRuleAddArgsSchema = z.object({
  title: z.string().min(1),
  category: WorldRuleCategorySchema.optional(),
  severity: WorldRuleSeveritySchema.optional(),
  statement: z.string().optional(),
  exceptions: z.string().optional(),
  alwaysActive: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
});

type WorldRuleAddArgs = z.infer<typeof worldRuleAddArgsSchema>;

export const worldRuleAdd: WriteOp<WorldRuleAddArgs> = {
  id: 'world_rule_add',
  level: 1,
  validate(args) {
    const res = worldRuleAddArgsSchema.safeParse(args);
    if (!res.success) {
      return { ok: false, error: res.error.message };
    }
    return { ok: true, value: res.data };
  },
  describe(args) {
    return {
      title: `Add World Rule: ${args.title}`,
      preview:
        [
          args.severity ? args.severity.toUpperCase() : '',
          args.category ? args.category : '',
          args.statement ? args.statement : '',
        ]
          .filter(Boolean)
          .join(' · ') || 'No rule statement provided.',
      kind: 'addition',
    };
  },
  async execute(args, ctx: ToolContext) {
    let list: WorldRule[] = [];
    try {
      const raw = await ctx.storage.readFile(`${ctx.prefix}WorldRules.json`);
      if (raw) {
        list = (JSON.parse(raw).rules || []) as WorldRule[];
      }
    } catch {
      // ignore missing/corrupt file on legacy projects
    }

    const uid = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newRule = WorldRuleSchema.parse({
      id: uid,
      title: args.title.trim(),
      category: args.category || 'other',
      severity: args.severity || 'hard',
      statement: args.statement?.trim() || '',
      exceptions: args.exceptions?.trim() || undefined,
      alwaysActive: args.alwaysActive ?? true,
      keywords: (args.keywords || []).map((k) => k.trim()).filter(Boolean),
      evidence: [],
    });

    list.push(newRule);

    await ctx.storage.writeFile(
      `${ctx.prefix}WorldRules.json`,
      JSON.stringify({ schemaVersion: 1, rules: list })
    );

    if (ctx.onUpdateWorldRules) {
      ctx.onUpdateWorldRules(list);
    }
  },
};
