import { describe, expect, it, vi } from 'vitest';
import { logEvent, telemetryEvent } from '../src/utils/telemetry';

describe('telemetry', () => {
  it('emits stable structured events and omits undefined fields', () => {
    expect(telemetryEvent('info', 'request.complete', {
      requestId: 'req-1',
      status: 200,
      provider: undefined,
    })).toBe('{"level":"info","event":"request.complete","requestId":"req-1","status":200}');
  });

  it('drops fields whose names indicate sensitive content', () => {
    const event = JSON.parse(telemetryEvent('error', 'provider.failed', {
      requestId: 'req-2',
      authToken: 'not-for-logs',
      transcript: 'private caller text',
      phoneNumber: '+15555550100',
    }));
    expect(event).toEqual({ level: 'error', event: 'provider.failed', requestId: 'req-2' });
  });

  it('uses the console method matching the level', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('error', 'request.failed', { requestId: 'req-3' });
    expect(error).toHaveBeenCalledWith('{"level":"error","event":"request.failed","requestId":"req-3"}');
    error.mockRestore();
  });
});
