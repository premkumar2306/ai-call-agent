// Booking times are stored as business-local wall-clock strings
// ("2026-04-15T09:00:00", no offset). External calendars work in real
// instants, so these helpers convert between the two using the business's
// IANA timezone.

const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

// Milliseconds `timeZone` is ahead of UTC at instant `date`.
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Real instant of a business-local wall-clock time. Strings that already carry an offset are taken as-is. */
export function toInstant(scheduledAt: string, timeZone: string | undefined): Date {
  if (HAS_OFFSET.test(scheduledAt)) return new Date(scheduledAt);
  const naive = Date.parse(`${scheduledAt.slice(0, 19).padEnd(19, ':00')}Z`);
  try {
    const zone = timeZone || 'UTC';
    // Two passes so a time on the far side of a DST change uses that side's offset.
    let t = naive - zoneOffsetMs(new Date(naive), zone);
    const second = zoneOffsetMs(new Date(t), zone);
    t = naive - second;
    return new Date(t);
  } catch {
    // Unknown IANA zone in sector config — treat as UTC rather than fail.
    return new Date(naive);
  }
}

/** Wall-clock "YYYY-MM-DDTHH:MM:SS" plus `minutes`, without timezone conversion. */
export function addMinutesLocal(local: string, minutes: number): string {
  const t = Date.parse(`${local.slice(0, 19).padEnd(19, ':00')}Z`) + minutes * 60_000;
  return new Date(t).toISOString().slice(0, 19);
}
