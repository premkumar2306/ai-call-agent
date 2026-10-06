/**
 * ui.tsx
 * ======
 *
 * Themed building blocks shared by every screen. Keeping them here means a
 * palette change lands everywhere at once, and screens stay about behaviour
 * rather than styling.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import { useTheme } from '@/lib/theme';

/** Elevated surface used for every grouped block of content. */
export function Card({
  children,
  style,
  accent,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  /** Draw the card with the accent border, for the "cleaned" side of an A/B. */
  accent?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.panel,
          borderColor: accent ? `${colors.accent}55` : colors.edge,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

/** Small uppercase label above a value. */
export function Label({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const { colors } = useTheme();
  return <Text style={[styles.label, { color: colors.faint }, style]}>{children}</Text>;
}

export function Title({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const { colors } = useTheme();
  return <Text style={[styles.title, { color: colors.text }, style]}>{children}</Text>;
}

export function Body({
  children,
  style,
  muted,
  numberOfLines,
}: {
  children: React.ReactNode;
  style?: TextStyle | TextStyle[];
  muted?: boolean;
  numberOfLines?: number;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[styles.body, { color: muted ? colors.muted : colors.text }, style]}>
      {children}
    </Text>
  );
}

export type PillTone = 'neutral' | 'success' | 'danger' | 'accent' | 'warning';

/**
 * Status chip — `Done`, `Failed`, `Expired`, `MEASURED`, and so on.
 *
 * Short status words read better capitalised, but a full sentence (the
 * comparison-matrix headlines) does not, so `uppercase` can be turned off.
 */
export function Pill({
  text,
  tone = 'neutral',
  uppercase = true,
}: {
  text: string;
  tone?: PillTone;
  uppercase?: boolean;
}) {
  const { colors } = useTheme();
  const map: Record<PillTone, string> = {
    neutral: colors.muted,
    success: colors.success,
    danger: colors.danger,
    accent: colors.accent,
    warning: colors.warning,
  };
  const colour = map[tone];
  return (
    <View style={[styles.pill, { backgroundColor: `${colour}22`, borderColor: `${colour}55` }]}>
      <Text
        style={[
          styles.pillText,
          { color: colour },
          uppercase ? null : { textTransform: 'none', fontSize: 11.5, letterSpacing: 0 },
        ]}>
        {text}
      </Text>
    </View>
  );
}

/** Primary / secondary / destructive button with a built-in busy state. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const inactive = disabled || busy;

  const background =
    variant === 'primary' ? colors.accent : variant === 'danger' ? `${colors.danger}1f` : 'transparent';
  const border =
    variant === 'primary' ? colors.accent : variant === 'danger' ? `${colors.danger}66` : colors.edge;
  const textColour =
    variant === 'primary' ? colors.onAccent : variant === 'danger' ? colors.danger : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, borderColor: border, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={textColour} size="small" />
      ) : (
        <Text style={[styles.buttonText, { color: textColour }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Determinate progress bar used during upload and processing. */
export function ProgressBar({ fraction }: { fraction: number }) {
  const { colors } = useTheme();
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ now: Math.round(clamped * 100), min: 0, max: 100 }}
      style={[styles.track, { backgroundColor: colors.edge }]}>
      <View
        style={[styles.fill, { width: `${clamped * 100}%`, backgroundColor: colors.accent }]}
      />
    </View>
  );
}

/** Centred empty-state block for History and error screens. */
export function EmptyState({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: colors.muted }]}>{detail}</Text> : null}
      {children}
    </View>
  );
}

/** One `label → value` line, used by stat blocks and Settings. */
export function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: colors.muted }]}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          { color: colors.text },
          mono ? { fontFamily: FONT_MONO } : null,
        ]}
        numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** Platform-safe monospace stack for ids, sizes and timings. */
export const FONT_MONO = 'Courier';

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  body: { fontSize: 14, lineHeight: 20 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  button: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 20,
  },
  buttonText: { fontSize: 15, fontWeight: '700' },
  track: { borderRadius: 999, height: 8, overflow: 'hidden', width: '100%' },
  fill: { borderRadius: 999, height: '100%' },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 32, paddingVertical: 56 },
  emptyTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyDetail: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingVertical: 7,
  },
  rowLabel: { fontSize: 14 },
  rowValue: { flexShrink: 1, fontSize: 14, fontWeight: '600', textAlign: 'right' },
});
