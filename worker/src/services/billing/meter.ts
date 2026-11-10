import type { LlmUsage } from './pricing';

// Per-call usage counters, filled in by CallRelay while the call runs. Plain
// in-memory additions only: nothing here may add latency to a turn. The totals
// are written to D1 once, after the call (recordUsage via waitUntil).
export class UsageMeter {
  ttsChars = 0;
  llmModel: string | null = null;
  llm: LlmUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  addTts(text: string) {
    this.ttsChars += text.length;
  }

  /** Accepts an Anthropic `usage` object (Message.usage). */
  addLlm(model: string | undefined, usage: {
    input_tokens?: number | null; output_tokens?: number | null;
    cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
  } | null | undefined) {
    if (!usage) return;
    if (model) this.llmModel = model;
    this.llm.input += usage.input_tokens ?? 0;
    this.llm.output += usage.output_tokens ?? 0;
    this.llm.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.llm.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }
}
