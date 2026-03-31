export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const AMBIGUOUS_SERVICE_PATTERNS = [
  /\bcheck[\s-]?up\b/i,
  /\bgeneral\b/i,
  /\bnot sure\b/i,
  /\bsomething else\b/i,
  /\bsomething\b/i,
  /\bwhatever\b/i,
  /\banything\b/i,
];

const SERVICE_CLARIFICATION_PATTERNS = [
  /what (specific )?service/i,
  /what would you like done/i,
  /what are you looking for/i,
  /which interests you/i,
  /which sounds better/i,
  /describe what you're looking for/i,
  /tell me what you'd like done/i,
  /what kind of work/i,
  /diagnostic inspection/i,
  /oil change/i,
];

export function isAmbiguousServiceIntent(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  return AMBIGUOUS_SERVICE_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasRecentServiceClarification(history: ConversationTurn[]): boolean {
  const recentAssistantTurns = history
    .filter((turn) => turn.role === 'assistant')
    .slice(-2);

  return recentAssistantTurns.some((turn) =>
    SERVICE_CLARIFICATION_PATTERNS.some((pattern) => pattern.test(turn.content))
  );
}

export function shouldEscalateUnclearService(history: ConversationTurn[], utterance: string): boolean {
  return isAmbiguousServiceIntent(utterance) && hasRecentServiceClarification(history);
}

export function getUnclearServiceEscalationResponse(businessName: string): string {
  return `I'm not sure which service fits best. Please call ${businessName} directly and we'll help you choose the right appointment.`;
}
