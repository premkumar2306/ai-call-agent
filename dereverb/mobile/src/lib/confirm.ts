/**
 * confirm.ts
 * ==========
 *
 * Cross-platform destructive-action confirmation.
 *
 * `Alert.alert` is a no-op on react-native-web, so a delete confirmed through
 * it would silently never happen in a browser. This routes web to
 * `window.confirm` and keeps the native dialog everywhere else.
 */
import { Alert, Platform } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label for the destructive action, e.g. `Delete`. */
  confirmLabel: string;
  onConfirm: () => void;
}

export function confirmDestructive({
  title,
  message,
  confirmLabel,
  onConfirm,
}: ConfirmOptions): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
