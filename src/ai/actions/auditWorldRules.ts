import { Action, ToolContext, CheckContinuityInput, ProposalResult, ReportItem } from '../types';
import { buildPrompt } from '../prompts/buildPrompt';
import { extractJson } from '../llm/parseJson';
import { Character, Location, Item, WorldRule } from '../../storage/schemas';
import { stripBeatTokens } from '../beats';

const SEVERITIES = ['high', 'medium', 'low'];

function ruleMatchesProse(rule: WorldRule, lowerProse: string): boolean {
  if (rule.severity === 'hard' || rule.alwaysActive) return true;
  if (rule.title && lowerProse.includes(rule.title.toLowerCase())) return true;
  if (Array.isArray(rule.keywords)) {
    return rule.keywords.some((kw) => kw.trim() && lowerProse.includes(kw.trim().toLowerCase()));
  }
  return false;
}

function formatRule(rule: WorldRule): string {
  const tag = rule.severity === 'hard' ? 'HARD RULE' : 'SOFT RULE';
  const lines = [
    `- [${tag}] ${rule.title} (Category: ${rule.category})${rule.alwaysActive ? ' [Always Active]' : ''}`,
    rule.statement ? `  Statement: ${rule.statement}` : '',
    rule.exceptions ? `  Valid Exceptions: ${rule.exceptions}` : '',
    rule.keywords?.length ? `  Keywords: ${rule.keywords.join(', ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function readAuditContext(ctx: ToolContext, lowerProse: string): Promise<{ rulesCount: number; bible: string }> {
  const parts: string[] = [];
  let rulesCount = 0;

  try {
    const r = await ctx.storage.readFile(`${ctx.prefix}WorldRules.json`);
    if (r) {
      const rules = (JSON.parse(r).rules || []) as WorldRule[];
      const activeRules = rules
        .filter((rule) => ruleMatchesProse(rule, lowerProse))
        .sort((a, b) => {
          const aScore = (a.severity === 'hard' ? 2 : 0) + (a.alwaysActive ? 1 : 0);
          const bScore = (b.severity === 'hard' ? 2 : 0) + (b.alwaysActive ? 1 : 0);
          return bScore - aScore;
        });
      rulesCount = activeRules.length;
      if (activeRules.length > 0) {
        parts.push('WORLD RULES:\n' + activeRules.map(formatRule).join('\n'));
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const i = await ctx.storage.readFile(`${ctx.prefix}Items.json`);
    if (i) {
      const items = (JSON.parse(i).items || []) as Item[];
      if (items.length) {
        parts.push(
          'ITEMS:\n' +
            items
              .map(
                (x) =>
                  `- ${x.name}${x.description ? `: ${x.description}` : ''}${x.significance ? ` — ${x.significance}` : ''}`
              )
              .join('\n')
        );
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const c = await ctx.storage.readFile(`${ctx.prefix}Characters.json`);
    if (c) {
      const chars = (JSON.parse(c).characters || []) as Character[];
      if (chars.length) {
        parts.push(
          'CHARACTERS:\n' +
            chars
              .map((x) => `- ${x.name}${x.role ? ` (${x.role})` : ''}${x.traits?.length ? `: ${x.traits.join(', ')}` : ''}`)
              .join('\n')
        );
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const l = await ctx.storage.readFile(`${ctx.prefix}Locations.json`);
    if (l) {
      const locs = (JSON.parse(l).locations || []) as Location[];
      if (locs.length) {
        parts.push(
          'LOCATIONS:\n' +
            locs.map((x) => `- ${x.name} (${x.scale})${x.significance ? `: ${x.significance}` : ''}`).join('\n')
        );
      }
    }
  } catch {
    /* ignore */
  }

  return { rulesCount, bible: parts.join('\n\n') };
}

export const auditWorldRules: Action<CheckContinuityInput> = {
  id: 'audit_world_rules',
  label: 'Audit World Rules',
  description: 'Audit the active chapter against World Rules, physics constraints, Items, and Story Bible.',
  level: 1,
  scope: 'chapter',
  allow: [],
  async propose(input, ctx): Promise<ProposalResult> {
    const rawMd = (await ctx.storage.readFile(`${ctx.prefix}Artifacts/chapter-${input.chapterId}.md`)) || '';
    const md = stripBeatTokens(rawMd);
    if (!md.trim()) {
      throw new Error('This chapter is empty — nothing to audit.');
    }

    const { rulesCount, bible } = await readAuditContext(ctx, md.toLowerCase());

    const activeIdx = ctx.chapterOrder.indexOf(input.chapterId);
    let precedingContinuity = '';
    if (activeIdx > 0) {
      const prevId = ctx.chapterOrder[activeIdx - 1];
      try {
        precedingContinuity = (await ctx.storage.readFile(`${ctx.prefix}Continuity/chapter-${prevId}.md`)) || '';
      } catch {
        // ignore
      }
    }

    if (rulesCount === 0 && !bible.trim() && !precedingContinuity.trim()) {
      return { type: 'report', items: [] };
    }

    const contextParts: string[] = [];
    if (bible.trim()) {
      contextParts.push(`STORY BIBLE & WORLD RULES:\n${bible.trim()}`);
    }
    if (precedingContinuity.trim()) {
      contextParts.push(`PRECEDING CHAPTER'S CONTINUITY:\n${precedingContinuity.trim()}`);
    }

    const context = contextParts.join('\n\n');
    const { system, user } = buildPrompt('audit_world_rules', { prose: md, context }, ctx.lang);

    let res = await ctx.callModel({ system, user, temperature: 0.25, thinking: 'medium' });
    let parsed = extractJson<{ flags: unknown[] }>(res.text);

    if (!parsed || !Array.isArray(parsed.flags)) {
      const repair = await ctx.callModel({
        system,
        user: `${user}\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object now.`,
        temperature: 0.2,
        thinking: 'medium',
      });
      res = repair;
      parsed = extractJson<{ flags: unknown[] }>(repair.text);
    }

    if (!parsed || !Array.isArray(parsed.flags)) {
      throw new Error('Audit failed — the model did not return usable JSON.');
    }

    const flags: ReportItem[] = [];
    for (const rawItem of parsed.flags) {
      const f = rawItem as Record<string, unknown> | null;
      if (!f || typeof f.statement !== 'string' || typeof f.conflict !== 'string') continue;
      const sev = typeof f.severity === 'string' ? f.severity : 'medium';
      flags.push({
        severity: SEVERITIES.includes(sev) ? (sev as ReportItem['severity']) : 'medium',
        statement: f.statement,
        conflict: f.conflict,
      });
    }

    return { type: 'report', items: flags };
  },
};
