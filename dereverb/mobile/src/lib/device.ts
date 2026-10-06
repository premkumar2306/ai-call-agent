/**
 * device.ts
 * =========
 *
 * Anonymous device identity.
 *
 * There are no accounts. A UUID is generated once on first launch, stored
 * locally, and sent as `X-Device-Id` so the server can scope History to this
 * device. It is not derived from any hardware identifier, so it cannot be used
 * to track the user across apps, and clearing app storage resets it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'echostrip.deviceId';

/** In-memory cache so the common path never touches storage. */
let cached: string | null = null;

/** Read (or create, once) this device's id. */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;

  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // Unreadable storage: fall through and mint a fresh id for this session.
  }

  const created = Crypto.randomUUID();
  cached = created;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, created);
  } catch {
    // If it cannot be persisted the id simply does not survive a relaunch;
    // the app still works for the current session.
  }
  return created;
}

/** Forget this device's identity, orphaning its server-side history. */
export async function resetDeviceId(): Promise<string> {
  cached = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort — getDeviceId() will mint a new one regardless.
  }
  return getDeviceId();
}
