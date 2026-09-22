import Anthropic from '@anthropic-ai/sdk';

export interface CallClassification {
  primary_category: string;
  primary_intent: string;
  confidence: number;
  secondary_intents: string[];
  caller_type: string;
  line_of_business: string;
  urgency: 'routine' | 'time_sensitive' | 'urgent_clinical' | 'emergency';
  sentiment: string;
  resolution_path: 'self_service_deflectable' | 'agent_required' | 'clinical_required' | 'escalation_required';
  compliance_flags: string[];
  entities: Record<string, string | null>;
  rationale: string;
}

const CATEGORIES = [
  'ELIGIBILITY_ENROLLMENT', 'BENEFITS_COVERAGE', 'CLAIMS', 'PRIOR_AUTH_REFERRAL',
  'PHARMACY_RX', 'PROVIDER_NETWORK', 'BILLING_PREMIUM', 'ACCOUNTS_HSA_FSA_HRA',
  'APPEALS_GRIEVANCES', 'CLINICAL_CARE_MGMT', 'ACCOUNT_TECH_SUPPORT',
  'GOVT_PROGRAM_SPECIFIC', 'OTHER_ROUTING',
] as const;
type Category = typeof CATEGORIES[number];

const LEAVES: Record<Category, string[]> = {
  ELIGIBILITY_ENROLLMENT: ['coverage_status','effective_term_date','dependent_add_remove','qle_plan_change','id_card_request','cob_other_insurance','open_enrollment_help'],
  BENEFITS_COVERAGE: ['service_covered_check','cost_share_inquiry','accumulator_status','preventive_coverage','ancillary_benefits','behavioral_health_benefit','dme_supplies','oon_coverage','supplemental_benefits'],
  CLAIMS: ['claim_status','claim_denial_reason','eob_explanation','member_claim_submission','claim_reprocess_request','balance_billing','overpayment_refund'],
  PRIOR_AUTH_REFERRAL: ['auth_requirement_check','auth_status','auth_denial_reason','referral_request_status','expedite_request','peer_to_peer'],
  PHARMACY_RX: ['formulary_check','rx_prior_auth','rx_cost_copay','step_therapy_qty_limit','tier_exception','mail_order_setup','refill_order_status','specialty_pharmacy','pharmacy_locator','rx_transfer'],
  PROVIDER_NETWORK: ['find_provider','network_status_verify','pcp_change','network_gap_exception','telehealth_options','provider_quality_info'],
  BILLING_PREMIUM: ['premium_balance','make_payment','invoice_copy','grace_period_lapse','subsidy_aptc','payment_posting_issue'],
  ACCOUNTS_HSA_FSA_HRA: ['account_balance','reimbursement_claim','card_issue','substantiation_docs','contribution_investment','eligible_expense_check'],
  APPEALS_GRIEVANCES: ['file_appeal','appeal_status','grievance_complaint','external_review_iro','expedited_appeal'],
  CLINICAL_CARE_MGMT: ['nurse_line_triage','case_disease_mgmt','behavioral_health_access','maternity_program','discharge_transition'],
  ACCOUNT_TECH_SUPPORT: ['portal_login','app_technical_issue','demographic_update','communication_prefs','authorized_rep_hipaa'],
  GOVT_PROGRAM_SPECIFIC: ['part_d_lis_extra_help','medicaid_redetermination','ltss_waiver','dsnp_coordination','star_ratings_hedis_outreach'],
  OTHER_ROUTING: ['wrong_department','provider_office_call','broker_employer','fraud_waste_abuse','general_info','unclear_insufficient'],
};

const FOLLOW_UP_QUESTIONS: Partial<Record<Category, string>> = {
  ELIGIBILITY_ENROLLMENT: "Are you checking on your coverage status, or do you need to make a change to your plan?",
  BENEFITS_COVERAGE: "Are you asking what's covered under your plan, or what you might owe out of pocket?",
  CLAIMS: "Is this about a claim still being processed, or a bill or Explanation of Benefits you already received?",
  PRIOR_AUTH_REFERRAL: "Are you checking whether something needs approval before it happens, or following up on an authorization already submitted?",
  PHARMACY_RX: "Is this about whether a medication is covered, the cost, or a refill or delivery?",
  PROVIDER_NETWORK: "Are you looking for a doctor or specialist, or checking whether a specific provider is in your network?",
  BILLING_PREMIUM: "Is this about your monthly premium, or a different charge on your account?",
  ACCOUNTS_HSA_FSA_HRA: "Are you checking your account balance, or do you need help with a reimbursement or your card?",
  APPEALS_GRIEVANCES: "Are you looking to formally appeal a decision, or report a concern about your experience?",
  CLINICAL_CARE_MGMT: "Are you looking to speak with a nurse right now, or get connected with an ongoing care program?",
  GOVT_PROGRAM_SPECIFIC: "Is this related to your Medicare or Medicaid coverage specifically?",
  OTHER_ROUTING: "Can you tell me a bit more about what you're calling about today?",
};

const PASS1_SYSTEM = `You are classifying a U.S. health plan member services call. Pick exactly ONE of these 13 categories:

${CATEGORIES.join(', ')}

Reply with ONLY the category name — no explanation, no punctuation, nothing else.`;

function buildPass2System(category: Category): string {
  const leaves = LEAVES[category].join(', ');
  return `You are an intent classification engine for a U.S. health plan member services contact center.

Category already determined: ${category}
Valid leaf intents: ${leaves}

DISAMBIGUATION RULES (apply in order):
1. Any medication/pharmacy/Rx question → pharmacy leaf, never benefits.
2. Denial for care NOT yet received → PRIOR_AUTH_REFERRAL leaf. Denial on an EOB/bill → CLAIMS leaf.
3. Asking WHY denied → *_denial_reason. Formally challenging it → file_appeal.
4. Any dissatisfaction expression → compliance_flags += grievance_trigger. MA/Part D + CMS/attorney/news mention → add cms_ctm_risk.
5. Cost question BEFORE service → cost_share_inquiry. "Why do I owe" AFTER service → eob_explanation.

SAFETY OVERRIDES (evaluate before anything else):
- Suicide / self-harm / crisis → compliance_flags += crisis_escalation, urgency = emergency, resolution_path = escalation_required
- Medical emergency (chest pain, stroke, overdose, severe bleeding) → urgency = emergency, resolution_path = clinical_required
- Fraud / billing for services not rendered → compliance_flags += fwa_suspected

Output ONLY valid JSON — no markdown fences:
{
  "primary_intent": "<leaf>",
  "confidence": 0.0,
  "secondary_intents": [],
  "caller_type": "member|dependent_adult|caregiver_aor|provider_office|pharmacy|broker|employer_group|unknown",
  "line_of_business": "commercial_group|individual_aca|medicare_advantage|part_d_pdp|medicaid|dsnp|tricare|unknown",
  "urgency": "routine|time_sensitive|urgent_clinical|emergency",
  "sentiment": "neutral|confused|frustrated|angry|distressed",
  "resolution_path": "self_service_deflectable|agent_required|clinical_required|escalation_required",
  "compliance_flags": [],
  "entities": {
    "member_id": null, "claim_number": null, "auth_number": null,
    "drug_name": null, "provider_name": null, "service_date": null,
    "dollar_amount": null, "facility": null
  },
  "rationale": "<one sentence, max 25 words>"
}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function classifyCall(
  transcript: string,
  apiKey: string,
): Promise<CallClassification> {
  const client = new Anthropic({ apiKey });
  const truncated = transcript.slice(0, 2000);

  // Pass 1 — category only, ~20 output tokens
  const p1 = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    system: PASS1_SYSTEM,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n"""\n${truncated}\n"""` }],
  });
  const rawCat = ((p1.content[0] as Anthropic.TextBlock)?.text ?? '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  const category = (CATEGORIES.find(c => rawCat === c) ?? CATEGORIES.find(c => rawCat.includes(c)) ?? 'OTHER_ROUTING') as Category;

  // Pass 2 — leaf + all slots for winning category, ~400 output tokens
  const p2 = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: buildPass2System(category),
    messages: [{ role: 'user', content: `TRANSCRIPT:\n"""\n${truncated}\n"""` }],
  });
  let raw2 = ((p2.content[0] as Anthropic.TextBlock)?.text ?? '').trim();
  raw2 = raw2.replace(/^```json?\s*/i, '').replace(/\s*```\s*$/i, '');

  try {
    const p = JSON.parse(raw2);
    return {
      primary_category: category,
      primary_intent:   p.primary_intent ?? 'unclear_insufficient',
      confidence:       typeof p.confidence === 'number' ? p.confidence : 0.5,
      secondary_intents: Array.isArray(p.secondary_intents) ? p.secondary_intents : [],
      caller_type:      p.caller_type ?? 'unknown',
      line_of_business: p.line_of_business ?? 'unknown',
      urgency:          p.urgency ?? 'routine',
      sentiment:        p.sentiment ?? 'neutral',
      resolution_path:  p.resolution_path ?? 'agent_required',
      compliance_flags: Array.isArray(p.compliance_flags) ? p.compliance_flags : [],
      entities:         p.entities ?? {},
      rationale:        p.rationale ?? '',
    };
  } catch {
    return fallback();
  }
}

function fallback(): CallClassification {
  return {
    primary_category: 'OTHER_ROUTING', primary_intent: 'unclear_insufficient',
    confidence: 0.3, secondary_intents: [], caller_type: 'unknown',
    line_of_business: 'unknown', urgency: 'routine', sentiment: 'neutral',
    resolution_path: 'agent_required', compliance_flags: [],
    entities: { member_id: null, claim_number: null, auth_number: null,
      drug_name: null, provider_name: null, service_date: null,
      dollar_amount: null, facility: null },
    rationale: 'Classification failed — routing to agent.',
  };
}

export function getCrisisResponse(): string {
  return "I want to make sure you're safe. If you're in immediate danger, please call 9-1-1. The 988 Suicide and Crisis Lifeline is available 24/7 — just call or text 9-8-8. Please stay on the line — I'm connecting you with a specialist right now.";
}

export function getFollowUpQuestion(category: string): string {
  return FOLLOW_UP_QUESTIONS[category as Category] ?? "Can you tell me a bit more about what you need help with today?";
}

export function buildClassificationContext(clf: CallClassification): string {
  const flags = clf.compliance_flags.length ? clf.compliance_flags.join(', ') : 'none';
  return `CALL INTELLIGENCE:
  Intent: ${clf.primary_category} → ${clf.primary_intent} (confidence: ${clf.confidence.toFixed(2)})
  Urgency: ${clf.urgency} | Sentiment: ${clf.sentiment} | LOB: ${clf.line_of_business}
  Caller type: ${clf.caller_type} | Routing: ${clf.resolution_path}
  Compliance flags: ${flags}
  Rationale: ${clf.rationale}`;
}
