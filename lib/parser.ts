/**
 * BOTS Shortcode Parser
 *
 * Parses w:> (WORK) and n:> (NEXT) shortcodes from user input.
 * Each shortcode captures content until the next shortcode or EOF.
 */

export interface ParsedQueue {
  type: 'queue';
  content: string;
  lineNumber: number;
}

export interface ParsedNext {
  type: 'next';
  content: string;
  lineNumber: number;
}

export type ParsedItem = ParsedQueue | ParsedNext;

export interface ParseResult {
  queues: ParsedQueue[];
  next: ParsedNext | null;
  raw: string;
}

const SHORTCODE_PATTERN = /^(w:>|n:>)\s*/;
const INLINE_SHORTCODE_SPLIT = /\s+(w:>|n:>)\s*/g;

/**
 * Parse input text for BOTS shortcodes
 *
 * Supports both:
 * - Multi-line format: shortcodes at start of lines
 * - Inline format: multiple shortcodes on one line
 *
 * @example
 * ```
 * // Multi-line
 * parseShortcodes(`
 *   w:> Add logout button to dashboard
 *   This should be in the header
 *   w:> Fix README typo
 *   n:> Review analytics proposal
 * `)
 *
 * // Inline
 * parseShortcodes("w:> Fix bug w:> Add feature n:> Review")
 * ```
 */
export function parseShortcodes(input: string): ParseResult {
  // First, normalize inline shortcodes to multi-line
  // Split "w:> foo w:> bar" into separate lines
  const normalized = input.replace(INLINE_SHORTCODE_SPLIT, '\n$1 ');

  const lines = normalized.split('\n');
  const queues: ParsedQueue[] = [];
  let next: ParsedNext | null = null;

  let currentItem: ParsedItem | null = null;
  let contentLines: string[] = [];

  const flushCurrent = () => {
    if (currentItem) {
      const content = contentLines.join('\n').trim();
      if (content) {  // Only add if there's actual content
        if (currentItem.type === 'queue') {
          queues.push({ ...currentItem, content });
        } else {
          next = { ...currentItem, content };
        }
      }
    }
    contentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match = trimmed.match(SHORTCODE_PATTERN);

    if (match) {
      // Found a shortcode - flush previous and start new
      flushCurrent();

      const shortcode = match[1];
      const remainder = trimmed.slice(match[0].length);

      if (shortcode === 'w:>') {
        currentItem = { type: 'queue', content: '', lineNumber: i + 1 };
      } else {
        currentItem = { type: 'next', content: '', lineNumber: i + 1 };
      }

      if (remainder) {
        contentLines.push(remainder);
      }
    } else if (currentItem) {
      // Continue collecting content for current item
      contentLines.push(line);
    }
    // Lines before any shortcode are ignored
  }

  // Flush final item
  flushCurrent();

  return { queues, next, raw: input };
}

/**
 * Check if input contains any BOTS shortcodes
 */
export function hasShortcodes(input: string): boolean {
  return /(?:^|\n)\s*(w:>|n:>)/m.test(input);
}

/**
 * Extract just the queue texts (for quick routing analysis)
 */
export function extractQueueTexts(input: string): string[] {
  const result = parseShortcodes(input);
  return result.queues.map(q => q.content);
}

// CLI support - parse from stdin or argument
if (typeof require !== 'undefined' && require.main === module) {
  const input = process.argv[2] || '';
  const result = parseShortcodes(input);
  console.log(JSON.stringify(result, null, 2));
}
