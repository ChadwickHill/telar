import { WriteOp, ToolContext } from '../types';
import {
  WorldRule,
  WorldRuleCategorySchema,
  WorldRuleSeveritySchema,
} from '../../storage/schemas';
import { z } from 'zod';

const worldRuleUpdateArgsSchema = z.object({
  id: z.string(),
  title: z.string(),
  changes: z.object({
    category: WorldRuleCategorySchema.optional(),
    severity: WorldRuleSeveritySchema.optional(),
    statement: z.string().optional(),
    exceptions: z.string().optional(),
    alwaysActive: z.boolean().optional(),
    keywords: z.array(z.string()).optional(),
  }),
});

type WorldRuleUpdateArgs = z.infer<typeof worldRuleUpdateArgsSchema>;

const union = (a: string[] = [], b: string[] = []) =>
  Array.from(new Set([...a, ...b].map((s) => s.trim()).filter(Boolean)));

export const worldRuleUpdate: WriteOp<WorldRuleUpdateArgs> = {
  id: 'world_rule_update',
  level: 1,
  validate(args) {
    const res = worldRuleUpdateArgsSchema.safeParse(args);
    if (!res.success) {
      return { ok: false, error: res.error.message };
    }
    return { ok: true, value: res.data };
  },
  describe(args) {
    const changes = args.changes;
    const parts: string[] = [];
    if (changes.severity) parts.push(`Severity: ${changes.severity.toUpperCase()}`);
    if (changes.category) parts.push(`Category: ${changes.category}`);
    if (changes.statement) parts.push(`Statement: ${changes.statement}`);
    if (changes.keywords?.length) parts.push(`Keywords: +${changes.keywords.join(', ')}`);
    return {
      title: `Update World Rule: ${args.title}`,
      preview: parts.join(' · ') || 'Update world rule fields.',
      kind: 'update',
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
      // ignore
    }

    const { id, changes } = args;
    list = list.map((rule) => {
      if (rule.id !== id) return rule;
      return {
        ...rule,
        category: changes.category ?? rule.category,
        severity: changes.severity ?? rule.severity,
        statement: changes.statement?.trim()
          ? rule.statement
            ? rule.statement
            : changes.statement.trim()
          : rule.statement,
        exceptions: changes.exceptions?.trim()
          ? rule.exceptions
            ? rule.exceptions
            : changes.exceptions.trim()
          : rule.exceptions,
        alwaysActive:
          typeof changes.alwaysActive === 'boolean' ? changes.alwaysActive : rule.alwaysActive,
        keywords: union(rule.keywords, changes.keywords),
      };
    });

    await ctx.storage.writeFile(
      `${ctx.prefix}WorldRules.json`,
      JSON.stringify({ schemaVersion: 1, rules: list })
    );

    if (ctx.onUpdateWorldRules) {
      ctx.onUpdateWorldRules(list);
    }
  },
};
