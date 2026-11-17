import { Action, ToolContext, CheckContinuityInput, ProposalResult, ReportItem } from '../types';
import { buildPrompt } from '../prompts/buildPrompt';
import { extractJson } from '../llm/parseJson';
import { Character, Location, Item, WorldRule } from '../../storage/schemas';
import { stripBeatTokens } from '../beats';

const SEVERITIES = ['high', 'medium', 'low'];

function isRuleActiveForProse(rule: WorldRule, lowerProse: string): boolean {
  if (rule.severity === 'hard' || rule.alwaysActive) return true;
  if (rule.title && lowerProse.includes(rule.title.toLowerCase())) return true;
  if (Array.isArray(rule.keywords)) {
    return rule.keywords.some((kw) => kw.trim() && lowerProse.includes(kw.trim().toLowerCase()));
  }
  return false;
}

async function readBibleContext(ctx: ToolContext, lowerProse: string): Promise<string> {
  const parts: string[] = [];
  try {
    const r = await ctx.storage.readFile(`${ctx.prefix}WorldRules.json`);
    if (r) {
      const rules = (JSON.parse(r).rules || []) as WorldRule[];
      const activeRules = rules.filter((rule) => isRuleActiveForProse(rule, lowerProse));
      if (activeRules.length) {
        parts.push(
          'WORLD RULES:\n' +
            activeRules
              .map(
                (rule) =>
                  `- [${rule.severity === 'hard' ? 'HARD RULE' : 'SOFT RULE'}] ${rule.title} (${rule.category}): ${rule.statement}${rule.exceptions ? ` (Exceptions: ${rule.exceptions})` : ''}`
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
  return parts.join('\n\n');
}

export const checkContinuity: Action<CheckContinuityInput> = {
  id: 'check_continuity',
  label: 'Check continuity',
  description: 'Flag statements in the chapter that contradict the Story Bible or World Rules.',
  level: 1,
  scope: 'chapter',
  allow: [], // Reports don't create side-effect write-ops
  async propose(input, ctx): Promise<ProposalResult> {
    const rawMd = (await ctx.storage.readFile(`${ctx.prefix}Artifacts/chapter-${input.chapterId}.md`)) || '';
    const md = stripBeatTokens(rawMd);
    if (!md.trim()) {
      throw new Error('This chapter is empty — nothing to check.');
    }

    const bible = await readBibleContext(ctx, md.toLowerCase());

    // Resolve preceding chapter continuity
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

    const contextParts: string[] = [];
    if (bible.trim()) {
      contextParts.push(`STORY BIBLE:\n${bible.trim()}`);
    }
    if (precedingContinuity.trim()) {
      contextParts.push(`PRECEDING CHAPTER'S CONTINUITY:\n${precedingContinuity.trim()}`);
    }

    if (contextParts.length === 0) {
      return { type: 'report', items: [] };
    }

    const context = contextParts.join('\n\n');
    const { system, user } = buildPrompt('check_continuity', { prose: md, context }, ctx.lang);

    let res = await ctx.callModel({ system, user, temperature: 0.3, thinking: 'medium' });
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
      throw new Error('Check failed — the model did not return usable JSON.');
    }

    const flags: ReportItem[] = [];
    for (const rawItem of parsed.flags) {
      const f = rawItem as Record<string, unknown> | null;
      if (!f || typeof f.statement !== 'string' || typeof f.conflict !== 'string') continue;
      const sev = typeof f.severity === 'string' ? f.severity : 'low';
      flags.push({
        severity: SEVERITIES.includes(sev) ? (sev as ReportItem['severity']) : 'low',
        statement: f.statement,
        conflict: f.conflict,
      });
    }

    return { type: 'report', items: flags };
  },
};
