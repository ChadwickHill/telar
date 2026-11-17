import { Action, ToolContext, CaptureInput, ProposalResult, WriteOpProposal, WorldRuleDraft } from '../types';
import { buildPrompt } from '../prompts/buildPrompt';
import { extractJson } from '../llm/parseJson';
import {
  WorldRule,
  WorldRuleCategory,
  WorldRuleCategorySchema,
  WorldRuleSeverity,
} from '../../storage/schemas';

async function readExistingRules(ctx: ToolContext): Promise<WorldRule[]> {
  try {
    const raw = await ctx.storage.readFile(`${ctx.prefix}WorldRules.json`);
    if (!raw) return [];
    return (JSON.parse(raw).rules || []) as WorldRule[];
  } catch {
    return [];
  }
}

export const captureWorldRules: Action<CaptureInput> = {
  id: 'capture_world_rules',
  label: 'Capture world rules',
  description: 'Extract physical laws, technical constraints, and world rules from the passage.',
  level: 1,
  scope: 'selection',
  allow: ['world_rule_add', 'world_rule_update'],
  async propose(input, ctx): Promise<ProposalResult> {
    const prose = input.selection?.text || '';
    if (!prose.trim()) {
      throw new Error('Select some prose first.');
    }

    const existing = await readExistingRules(ctx);
    const context = existing.length
      ? `World rules already in the bible (do not duplicate, propose updates instead): ${existing
          .map((r) => r.title)
          .join(', ')}.`
      : undefined;

    const { system, user } = buildPrompt('capture_world_rules', { prose, context }, ctx.lang);

    let res = await ctx.callModel({ system, user, temperature: 0.4, thinking: 'low' });
    let parsed = extractJson<{ rules: unknown[] }>(res.text);

    if (!parsed || !Array.isArray(parsed.rules)) {
      const repair = await ctx.callModel({
        system,
        user: `${user}\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object now.`,
        temperature: 0.2,
        thinking: 'low',
      });
      res = repair;
      parsed = extractJson<{ rules: unknown[] }>(repair.text);
    }

    if (!parsed || !Array.isArray(parsed.rules)) {
      throw new Error('Capture failed — the model did not return usable JSON.');
    }

    const existingByTitle = new Map(existing.map((r) => [r.title.trim().toLowerCase(), r]));
    const list: WriteOpProposal[] = [];

    for (const rawItem of parsed.rules) {
      const item = rawItem as Record<string, unknown> | null;
      if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;

      const parsedCategory = WorldRuleCategorySchema.safeParse(item.category);
      const category: WorldRuleCategory = parsedCategory.success ? parsedCategory.data : 'other';
      const severity: WorldRuleSeverity = item.severity === 'soft' ? 'soft' : 'hard';

      const draft: WorldRuleDraft = {
        title: item.title.trim(),
        category,
        severity,
        statement: typeof item.statement === 'string' ? item.statement.trim() : '',
        exceptions: typeof item.exceptions === 'string' && item.exceptions.trim() ? item.exceptions.trim() : undefined,
        alwaysActive: typeof item.alwaysActive === 'boolean' ? item.alwaysActive : severity === 'hard',
        keywords: Array.isArray(item.keywords)
          ? item.keywords.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
          : [],
      };

      const match = existingByTitle.get(draft.title.toLowerCase());
      if (match) {
        const { title: _ignoredTitle, ...changes } = draft;
        void _ignoredTitle;
        list.push({
          op: 'world_rule_update',
          args: { id: match.id, title: match.title, changes },
        });
      } else {
        list.push({
          op: 'world_rule_add',
          args: draft,
        });
      }
    }

    return { type: 'proposals', list };
  },
};
