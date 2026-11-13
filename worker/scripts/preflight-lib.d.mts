export function parseSecretList(stdout: string): string[];
export function nextAction(i: any, secretNames: string[] | null): string;
export function render(data: any, secretNames: string[] | null): string;
export function scrub(text: string, adminKey: string): string;
