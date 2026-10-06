/**
 * Settings tab — appearance, storage, and what this app knows about you.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Button, Card, FONT_MONO, Label, Row } from '@/components/ui';
import { API_BASE, HealthReport, clearHistory, fetchHealth } from '@/lib/api';
import { confirmDestructive } from '@/lib/confirm';
import { getDeviceId } from '@/lib/device';
import { ThemeMode, useTheme } from '@/lib/theme';

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const [deviceId, setDeviceId] = useState('');
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDeviceId().then((id) => active && setDeviceId(id));
    fetchHealth()
      .then((report) => active && setHealth(report))
      .catch(() => active && setHealth(null));
    return () => {
      active = false;
    };
  }, []);

  const confirmClear = useCallback(() => {
    const run = async () => {
      setClearing(true);
      try {
        const removed = await clearHistory();
        setNotice(`Removed ${removed} recording${removed === 1 ? '' : 's'}.`);
      } catch (caught: any) {
        setNotice(caught?.message ?? 'Could not clear your history.');
      } finally {
        setClearing(false);
      }
    };

    confirmDestructive({
      title: 'Clear all history?',
      message:
        'Every recording and its audio will be deleted from the server. This cannot be undone.',
      confirmLabel: 'Clear',
      onConfirm: run,
    });
  }, []);

  const retentionDays = health ? Math.round(health.limits.retention_minutes / 1440) : null;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Label>Appearance</Label>
          <View style={[styles.segment, { backgroundColor: colors.panelAlt, borderColor: colors.edge }]}>
            {MODES.map((option) => {
              const active = mode === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setMode(option.value)}
                  style={[
                    styles.segmentItem,
                    active ? { backgroundColor: colors.accent } : null,
                  ]}>
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? colors.onAccent : colors.muted },
                    ]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card>
          <Label>Server</Label>
          <View style={{ marginTop: 6 }}>
            <Row label="API" value={API_BASE} mono />
            <Row
              label="Engine"
              value={health ? (health.engine.name ?? 'unavailable') : 'unreachable'}
            />
            <Row label="Status" value={health ? health.status : 'offline'} />
            {retentionDays != null ? (
              <Row label="Audio kept for" value={`${retentionDays} day${retentionDays === 1 ? '' : 's'}`} />
            ) : null}
          </View>
        </Card>

        <Card>
          <Label>Privacy</Label>
          <Body muted style={{ marginTop: 8 }}>
            There is no account. This app identifies itself with a random id generated on first
            launch — it is not derived from your device and is sent only to your own server.
          </Body>
          <Text style={[styles.deviceId, { color: colors.faint, fontFamily: FONT_MONO }]}>
            {deviceId || '…'}
          </Text>
        </Card>

        <Card style={{ borderColor: `${colors.danger}44` }}>
          <Label>Danger zone</Label>
          <Body muted style={{ marginTop: 8, marginBottom: 12 }}>
            Deletes every recording on the server for this device, audio included.
          </Body>
          <Button label="Clear all history" variant="danger" onPress={confirmClear} busy={clearing} />
          {notice ? (
            <Body muted style={{ marginTop: 10 }}>
              {notice}
            </Body>
          ) : null}
        </Card>

        <Text style={[styles.footer, { color: colors.faint }]}>EchoStrip · v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 40 },
  segment: {
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    marginTop: 10,
    padding: 4,
  },
  segmentItem: { alignItems: 'center', borderRadius: 9, flex: 1, paddingVertical: 9 },
  segmentText: { fontSize: 14, fontWeight: '700' },
  deviceId: { fontSize: 11, marginTop: 10 },
  footer: { fontSize: 12, marginTop: 6, textAlign: 'center' },
});
