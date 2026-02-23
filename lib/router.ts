/**
 * BOTS Router
 *
 * Analyzes queue content to determine entry worker based on keywords.
 * Loads routing rules from taskmaster.json state file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStatePath } from './integrations/detect.js';

export interface RoutingRule {
  description: string;
  entry: string;
  keywords: string[];
  /** Nexus extended format: suggested_workers instead of entry */
  suggested_workers?: string[];
}

export interface RouteMatch {
  route: string;
  entry: string;
  description: string;
  confidence: number;
  matchedKeywords: string[];
}

let routingRulesCache: Record<string, RoutingRule> | null = null;

/**
 * Resolve the BOTS state file path.
 * Uses integration-aware path resolution.
 */
function getBotsStatePath(): string {
  return getStatePath('taskmaster.json');
}

/**
 * Load routing rules from taskmaster.json
 */
export function loadRoutingRules(configPath?: string): Record<string, RoutingRule> {
  if (routingRulesCache) return routingRulesCache;

  const filePath = configPath || getBotsStatePath();

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content);
    const routing = config.routing || {};
    const rules: Record<string, RoutingRule> = {};

    // Determine source: BOTS flat format or Nexus domain_hints format
    const source = routing.domain_hints || routing;

    for (const [key, value] of Object.entries(source)) {
      // Skip metadata keys (start with _ or are not objects)
      if (key.startsWith('_') || typeof value !== 'object' || value === null) continue;
      const rule = value as Record<string, any>;
      // Skip if no keywords array
      if (!Array.isArray(rule.keywords)) continue;

      rules[key] = {
        description: rule.description || key,
        entry: rule.entry || (Array.isArray(rule.suggested_workers) ? rule.suggested_workers[0] : '$W.k.analyst'),
        keywords: rule.keywords,
        suggested_workers: rule.suggested_workers
      };
    }

    routingRulesCache = rules;
    return rules;
  } catch (error) {
    console.error(`Failed to load routing rules from ${filePath}:`, error);
    return {};
  }
}

/**
 * Clear routing rules cache (for testing or config reload)
 */
export function clearRoutingCache(): void {
  routingRulesCache = null;
}

/**
 * Analyze text and find the best matching route
 *
 * @param text - Queue content to analyze
 * @returns Best matching route or null if no match
 */
export function findRoute(text: string, configPath?: string): RouteMatch | null {
  const rules = loadRoutingRules(configPath);
  const normalizedText = text.toLowerCase();
  const words = normalizedText.split(/\s+/);

  let bestMatch: RouteMatch | null = null;

  for (const [routeName, rule] of Object.entries(rules)) {
    if (!Array.isArray(rule.keywords)) continue;
    const matchedKeywords: string[] = [];

    for (const keyword of rule.keywords) {
      // Check for keyword in text (word boundary aware)
      const keywordLower = keyword.toLowerCase();
      if (words.some(word => word.startsWith(keywordLower) || word.includes(keywordLower))) {
        matchedKeywords.push(keyword);
      }
    }

    if (matchedKeywords.length > 0) {
      const confidence = matchedKeywords.length / rule.keywords.length;

      if (!bestMatch || confidence > bestMatch.confidence ||
          (confidence === bestMatch.confidence && matchedKeywords.length > bestMatch.matchedKeywords.length)) {
        bestMatch = {
          route: routeName,
          entry: rule.entry,
          description: rule.description,
          confidence,
          matchedKeywords
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Get the entry worker for a queue item
 * Falls back to $W.k.analyst if no route matches
 */
export function getEntryWorker(text: string, configPath?: string): string {
  const match = findRoute(text, configPath);
  return match?.entry || '$W.k.analyst';  // Default to analyst for unknown work
}

/**
 * Analyze multiple queue items and return their routes
 */
export function routeQueues(queueTexts: string[], configPath?: string): Array<{
  text: string;
  route: RouteMatch | null;
  entryWorker: string;
}> {
  return queueTexts.map(text => ({
    text,
    route: findRoute(text, configPath),
    entryWorker: getEntryWorker(text, configPath)
  }));
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2] || '';
  const result = findRoute(text);
  console.log(JSON.stringify(result, null, 2));
}
