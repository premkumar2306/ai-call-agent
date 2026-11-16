type TelemetryLevel = 'info' | 'warn' | 'error';

type TelemetryValue = string | number | boolean | null | undefined;

const SENSITIVE_KEY = /(?:authorization|cookie|secret|token|password|transcript|utterance|message|phone|email)/i;

export function telemetryEvent(
  level: TelemetryLevel,
  event: string,
  fields: Record<string, TelemetryValue> = {},
): string {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => value !== undefined && !SENSITIVE_KEY.test(key)),
  );
  return JSON.stringify({ level, event, ...safeFields });
}

export function logEvent(
  level: TelemetryLevel,
  event: string,
  fields: Record<string, TelemetryValue> = {},
): void {
  const line = telemetryEvent(level, event, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
