// Types for scripts/whatsapp-setup-lib.mjs, so the unit tests type-check.
export const GRAPH_VERSION: string;
export interface SetupArgs { dryRun: boolean; showVerifyToken: boolean; help: boolean; map?: string; phoneNumberId?: string; testTo?: string; registerPin?: string; envFile?: string; label?: string }
export function parseArgs(argv: string[]): SetupArgs;
export function parseDotEnv(text: string): Record<string, string>;
export function mergeConfig(dotenv: Record<string, string>, env: Record<string, string | undefined>): {
  accessToken?: string; wabaId?: string; verifyToken?: string; phoneNumberId?: string; workerUrl?: string; adminKey?: string; business?: string; testTo?: string;
};
export function mask(secret?: string): string;
export function redact(s: string, ...secrets: (string | undefined)[]): string;
export function webhookUrl(workerUrl?: string): string;
export function normalizeRecipient(number: string): string;
export interface PhoneRow { phone_number_id: string; number: string; verified_name: string; quality: string; status: string; name_status: string }
export function describePhoneNumbers(numbers: any[]): { rows: PhoneRow[]; warnings: string[] };
export function needsRegistration(number: { status?: string } | null | undefined): boolean;
export function choosePhoneNumber(rows: PhoneRow[], wanted?: string): PhoneRow | null;
export function planMapping(existing: any[], phoneNumberId: string, business: string): 'create' | 'update' | 'same';
export function explainGraphError(status: number, body: any): string;
