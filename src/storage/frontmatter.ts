/**
 * Pure TypeScript YAML frontmatter parser & serializer + deterministic filename helpers.
 * Zero external runtime dependencies.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Strip diacritics (including Vietnamese đ/Đ) and produce a clean, safe filename slug.
 */
export function slugifyFilename(name: string, fallback: string): string {
  const normalized = (name || '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');

  if (normalized) return normalized;

  const fallbackSlug = (fallback || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return fallbackSlug || 'untitled';
}

export function padOrder(index: number): string {
  const safe = Number.isFinite(index) && index >= 1 ? Math.floor(index) : 1;
  return String(safe).padStart(2, '0');
}

// ---- YAML Scalar & Block Helpers -------------------------------------------

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      const prev = i > 0 ? line[i - 1] : '';
      if (prev !== '\\') inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i).trimEnd();
      }
    }
  }
  return line;
}

function parseQuotedString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitInlineArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      const prev = i > 0 ? inner[i - 1] : '';
      if (prev !== '\\') inDouble = !inDouble;
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble) {
      if (current.trim().length > 0) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseQuotedString(trimmed);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArrayItems(inner).map((item) => parseScalar(item));
  }

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }

  return trimmed;
}

function findUnquotedColon(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      const prev = i > 0 ? line[i - 1] : '';
      if (prev !== '\\') inDouble = !inDouble;
    } else if (ch === ':' && !inSingle && !inDouble) {
      const next = line[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return i;
      }
    }
  }
  return -1;
}

interface YamlLine {
  indent: number;
  text: string;
}

function preprocessYamlLines(yamlBlock: string): YamlLine[] {
  const rawLines = yamlBlock.replace(/\r\n/g, '\n').split('\n');
  const result: YamlLine[] = [];
  for (const raw of rawLines) {
    const cleaned = stripInlineComment(raw);
    const trimmed = cleaned.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    result.push({ indent, text: trimmed });
  }
  return result;
}

function parseYamlBlock(lines: YamlLine[], startIdx: number, baseIndent: number): { value: unknown; nextIdx: number } {
  if (startIdx >= lines.length) {
    return { value: {}, nextIdx: startIdx };
  }

  const first = lines[startIdx];
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseYamlSequence(lines, startIdx, first.indent);
  }
  return parseYamlMapping(lines, startIdx, Math.max(baseIndent, first.indent));
}

function parseYamlSequence(lines: YamlLine[], startIdx: number, seqIndent: number): { value: unknown[]; nextIdx: number } {
  const arr: unknown[] = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.indent < seqIndent) break;
    if (line.indent > seqIndent) break;
    if (!line.text.startsWith('- ') && line.text !== '-') break;

    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (!rest) {
      // Nested block under bare '-'
      idx++;
      if (idx < lines.length && lines[idx].indent > seqIndent) {
        const nested = parseYamlBlock(lines, idx, lines[idx].indent);
        arr.push(nested.value);
        idx = nested.nextIdx;
      } else {
        arr.push(null);
      }
      continue;
    }

    const colonIdx = findUnquotedColon(rest);
    if (colonIdx !== -1) {
      // Inline object item inside sequence: `- with: "Elena"` followed by indented keys
      const obj: Record<string, unknown> = {};
      const key = parseQuotedString(rest.slice(0, colonIdx).trim());
      const valRaw = rest.slice(colonIdx + 1).trim();
      const itemIndent = seqIndent + 2;

      if (!valRaw) {
        idx++;
        if (idx < lines.length && lines[idx].indent > itemIndent) {
          const nestedVal = parseYamlBlock(lines, idx, lines[idx].indent);
          obj[key] = nestedVal.value;
          idx = nestedVal.nextIdx;
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(valRaw);
        idx++;
      }

      // Consume remaining sibling properties of this object at indent >= itemIndent
      if (idx < lines.length && lines[idx].indent >= itemIndent && !(lines[idx].text.startsWith('- ') && lines[idx].indent === seqIndent)) {
        const restObj = parseYamlMapping(lines, idx, lines[idx].indent);
        Object.assign(obj, restObj.value);
        idx = restObj.nextIdx;
      }

      arr.push(obj);
    } else {
      arr.push(parseScalar(rest));
      idx++;
    }
  }

  return { value: arr, nextIdx: idx };
}

function parseYamlMapping(lines: YamlLine[], startIdx: number, mapIndent: number): { value: Record<string, unknown>; nextIdx: number } {
  const obj: Record<string, unknown> = {};
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.indent < mapIndent) break;
    if (line.indent > mapIndent) {
      // Unexpected indent jump; stop gracefully
      break;
    }
    if (line.text.startsWith('- ') || line.text === '-') break;

    const colonIdx = findUnquotedColon(line.text);
    if (colonIdx === -1) {
      idx++;
      continue;
    }

    const key = parseQuotedString(line.text.slice(0, colonIdx).trim());
    const valRaw = line.text.slice(colonIdx + 1).trim();
    idx++;

    if (!valRaw) {
      if (idx < lines.length && (lines[idx].indent > mapIndent || (lines[idx].indent === mapIndent && (lines[idx].text.startsWith('- ') || lines[idx].text === '-')))) {
        const nested = parseYamlBlock(lines, idx, lines[idx].indent);
        obj[key] = nested.value;
        idx = nested.nextIdx;
      } else {
        obj[key] = '';
      }
    } else {
      obj[key] = parseScalar(valRaw);
    }
  }

  return { value: obj, nextIdx: idx };
}

/**
 * Parses `---\n...\n---` YAML frontmatter from a Markdown file.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = (raw || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { data: {}, body: normalized };
  }

  const afterOpen = normalized.slice(4);
  if (afterOpen.startsWith('---')) {
    const afterClose = afterOpen.slice(3);
    const body = afterClose.replace(/^\n+/, '');
    return { data: {}, body };
  }

  const closeMatch = afterOpen.match(/\n---(?:\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { data: {}, body: normalized };
  }

  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  const bodyRaw = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const body = bodyRaw.replace(/^\n+/, '');

  const lines = preprocessYamlLines(yamlBlock);
  if (lines.length === 0) {
    return { data: {}, body };
  }

  const parsed = parseYamlMapping(lines, 0, lines[0].indent);
  return { data: parsed.value, body };
}

// ---- YAML Serializer -------------------------------------------------------

function quoteYamlString(val: string): string {
  const escaped = val
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function serializeScalar(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'null';
  return quoteYamlString(String(val));
}

function isSimplePrimitiveArray(arr: unknown[]): boolean {
  return arr.every(
    (item) =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
  );
}

function serializeYamlEntry(key: string, val: unknown, indentLevel: number): string[] {
  const indent = '  '.repeat(indentLevel);
  const safeKey = /^[a-zA-Z0-9_-]+$/.test(key) ? key : quoteYamlString(key);

  if (val === undefined) return [];

  if (
    val === null ||
    typeof val === 'string' ||
    typeof val === 'number' ||
    typeof val === 'boolean'
  ) {
    return [`${indent}${safeKey}: ${serializeScalar(val)}`];
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return [`${indent}${safeKey}: []`];
    }

    if (isSimplePrimitiveArray(val)) {
      const inlineItems = val.map((item) => serializeScalar(item));
      const inline = `${indent}${safeKey}: [${inlineItems.join(', ')}]`;
      if (inline.length <= 100 && val.length <= 8) {
        return [inline];
      }
      const lines = [`${indent}${safeKey}:`];
      for (const item of inlineItems) {
        lines.push(`${indent}  - ${item}`);
      }
      return lines;
    }

    const lines = [`${indent}${safeKey}:`];
    for (const item of val) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          lines.push(`${indent}  - {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0];
        const safeFirstKey = /^[a-zA-Z0-9_-]+$/.test(firstKey) ? firstKey : quoteYamlString(firstKey);
        if (
          firstVal === null ||
          typeof firstVal === 'string' ||
          typeof firstVal === 'number' ||
          typeof firstVal === 'boolean' ||
          (Array.isArray(firstVal) && firstVal.length === 0)
        ) {
          lines.push(`${indent}  - ${safeFirstKey}: ${Array.isArray(firstVal) ? '[]' : serializeScalar(firstVal)}`);
        } else {
          lines.push(`${indent}  -`);
          lines.push(...serializeYamlEntry(firstKey, firstVal, indentLevel + 2));
        }
        for (let i = 1; i < entries.length; i++) {
          const [subKey, subVal] = entries[i];
          lines.push(...serializeYamlEntry(subKey, subVal, indentLevel + 2));
        }
      } else {
        lines.push(`${indent}  - ${serializeScalar(item)}`);
      }
    }
    return lines;
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return [`${indent}${safeKey}: {}`];
    }
    const lines = [`${indent}${safeKey}:`];
    for (const [subKey, subVal] of entries) {
      lines.push(...serializeYamlEntry(subKey, subVal, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${safeKey}: ${serializeScalar(String(val))}`];
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    lines.push(...serializeYamlEntry(key, val, 0));
  }
  const cleanBody = (body || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const yamlPart = lines.join('\n');
  if (!yamlPart) {
    return cleanBody;
  }
  return cleanBody
    ? `---\n${yamlPart}\n---\n\n${cleanBody}`
    : `---\n${yamlPart}\n---\n`;
}
