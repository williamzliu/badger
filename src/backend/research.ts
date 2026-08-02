import { randomUUID } from 'node:crypto';
import type { Candidate } from '../shared/types.js';

export type ResearchRequest = {
  goal: string;
  query: string;
  locationHint: string;
  participantCount: number;
};

export type ResearchedCandidate = Candidate & {
  sourceUrl: string;
  evidence: string;
};

export interface OptionResearcher {
  research(input: ResearchRequest): Promise<ResearchedCandidate[]>;
}

type OpenAIOptionResearcherConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  fetch?: typeof globalThis.fetch;
};

function cacheKey(input: ResearchRequest): string {
  return `${input.goal}|${input.query}|${input.locationHint}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function freshIds(options: ResearchedCandidate[]): ResearchedCandidate[] {
  return options.map((option) => ({ ...option, id: randomUUID() }));
}

function outputText(body: unknown): string {
  if (!body || typeof body !== 'object') throw new Error('Research response was empty');
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) throw new Error('Research response omitted output');
  for (const item of output) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'message') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const text = content.find((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'output_text') as
      | { text?: unknown }
      | undefined;
    if (typeof text?.text === 'string') return text.text;
  }
  throw new Error('Research response omitted output_text');
}

function parseOptions(value: unknown): ResearchedCandidate[] {
  if (!value || typeof value !== 'object') throw new Error('Research output was not an object');
  const options = (value as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length < 2) throw new Error('Research returned fewer than two options');
  return options.slice(0, 8).map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Research option ${index + 1} was invalid`);
    const option = raw as Record<string, unknown>;
    const required = ['venue', 'time', 'slot', 'format', 'location', 'sourceUrl', 'evidence'] as const;
    for (const field of required) {
      if (typeof option[field] !== 'string' || !(option[field] as string).trim()) {
        throw new Error(`Research option ${index + 1} omitted ${field}`);
      }
    }
    const sourceUrl = String(option.sourceUrl);
    if (!/^https?:\/\//.test(sourceUrl)) throw new Error(`Research option ${index + 1} has an invalid source URL`);
    const price = Number(option.price);
    return {
      id: randomUUID(),
      theater: String(option.venue).trim(),
      time: String(option.time).trim(),
      slot: String(option.slot).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      format: String(option.format).trim(),
      price: Number.isFinite(price) && price >= 0 ? price : 0,
      location: String(option.location).trim(),
      sourceUrl,
      evidence: String(option.evidence).trim(),
    };
  });
}

export class OpenAIOptionResearcher implements OptionResearcher {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly cache = new Map<string, { expiresAt: number; options: ResearchedCandidate[] }>();
  private readonly inFlight = new Map<string, Promise<ResearchedCandidate[]>>();

  constructor(private readonly config: OpenAIOptionResearcherConfig) {
    if (!config.apiKey) throw new Error('OpenAI research apiKey is required');
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async research(input: ResearchRequest): Promise<ResearchedCandidate[]> {
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return freshIds(cached.options);
    const existing = this.inFlight.get(key);
    if (existing) return freshIds(await existing);

    const pending = this.fetchResearch(input).then((options) => {
      this.cache.set(key, {
        expiresAt: Date.now() + (this.config.cacheTtlMs ?? 30 * 60_000),
        options,
      });
      return options;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return freshIds(await pending);
  }

  private async fetchResearch(input: ResearchRequest): Promise<ResearchedCandidate[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000),
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model ?? 'gpt-5.4-mini',
        tools: [{ type: 'web_search' }],
        reasoning: { effort: this.config.reasoningEffort ?? 'none' },
        input: [{
          role: 'user',
          content: `Research concrete, currently plausible options for a group plan.
Goal: ${input.goal}
Search direction chosen by the coordinator: ${input.query}
Location hint: ${input.locationHint}
Group size: ${input.participantCount}
Current local timestamp: ${new Date().toISOString()}

Return 3-4 distinct options over multiple feasible time windows. Use direct source pages and do not invent availability, hours, prices, or addresses. The slot must be a scheduling label such as thursday_evening. If exact price is unavailable, use 0 and say so in evidence.`,
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'badger_research_options',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['options'],
              properties: {
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['venue', 'time', 'slot', 'format', 'price', 'location', 'sourceUrl', 'evidence'],
                    properties: {
                      venue: { type: 'string' },
                      time: { type: 'string' },
                      slot: { type: 'string' },
                      format: { type: 'string' },
                      price: { type: 'number' },
                      location: { type: 'string' },
                      sourceUrl: { type: 'string' },
                      evidence: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Option research failed (${response.status}): ${raw || response.statusText}`);
    return parseOptions(JSON.parse(outputText(JSON.parse(raw))) as unknown);
  }
}
