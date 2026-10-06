/**
 * Create tab — pick an audio file, upload it, watch it being cleaned.
 *
 * The upload leg reports real progress; the processing leg happens server-side
 * with no progress channel, so the UI narrates the stages the backend actually
 * runs and eases the bar toward (but never to) 100% so it never looks frozen.
 */
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Button, Card, Label, Pill, ProgressBar, Title } from '@/components/ui';
import {
  ACCEPTED_EXTENSIONS,
  PickedAudio,
  fetchHealth,
  uploadAudio,
  validateAudio,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useTheme } from '@/lib/theme';

/** Narration shown while the server works, mirroring the real pipeline. */
const STAGES: [string, string][] = [
  ['Analyzing acoustics…', 'Mapping the room signature'],
  ['Stripping room reverb…', 'DeepFilterNet inference running'],
  ['Separating voice from tail…', 'Isolating direct sound'],
  ['Suppressing echo…', 'Attenuating late reflections'],
  ['Rebuilding clean audio…', 'Encoding 48 kHz output'],
  ['Finalizing benchmarks…', 'Timing every stage'],
];

export default function CreateScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [picked, setPicked] = useState<PickedAudio | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState<boolean | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearInterval);
    timersRef.current = [];
  }, []);

  // Abort any in-flight upload if the screen goes away, rather than leaking it.
  useEffect(() => {
    return () => {
      clearTimers();
      abortRef.current?.();
    };
  }, [clearTimers]);

  useEffect(() => {
    let active = true;
    fetchHealth()
      .then((health) => active && setEngineReady(health.engine.available))
      .catch(() => active && setEngineReady(false));
    return () => {
      active = false;
    };
  }, []);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      const audio: PickedAudio = {
        uri: asset.uri,
        name: asset.name,
        size: asset.size,
        mimeType: asset.mimeType,
        file: asset.file,
      };
      const problem = validateAudio(audio);
      if (problem) {
        setError(problem);
        setPicked(null);
        return;
      }
      setPicked(audio);
    } catch {
      setError('Could not open the file picker.');
    }
  }, []);

  const start = useCallback(async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    setStageIndex(0);

    const { promise, abort } = uploadAudio(picked, (fraction) => {
      // Reserve the top of the bar for the server-side leg.
      setProgress(fraction * 0.7);
    });
    abortRef.current = abort;

    // Once the bytes are sent, narrate the processing stages.
    const stageTimer = setInterval(() => setStageIndex((i) => i + 1), 2600);
    const creepTimer = setInterval(() => {
      setProgress((current) => (current < 0.7 ? current : current + (0.97 - current) * 0.12));
    }, 400);
    timersRef.current = [stageTimer, creepTimer];

    try {
      const result = await promise;
      setProgress(1);
      setPicked(null);
      router.push(`/job/${result.job_id}`);
    } catch (caught: any) {
      setError(caught?.message ?? 'Processing failed.');
    } finally {
      clearTimers();
      abortRef.current = null;
      setBusy(false);
    }
  }, [picked, router, clearTimers]);

  const [headline, detail] = STAGES[stageIndex % STAGES.length];

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Title style={styles.heroTitle}>Strip the room out of your audio.</Title>
          <Body muted style={styles.heroBody}>
            Pick a reverberant recording and the AI removes echo and room tone. No sliders,
            no plugins.
          </Body>
        </View>

        {engineReady === false ? (
          <Card style={{ borderColor: `${colors.warning}55` }}>
            <View style={styles.rowGap}>
              <Pill text="Engine offline" tone="warning" />
            </View>
            <Body muted style={{ marginTop: 8 }}>
              The server cannot reach its de-reverb engine right now, so uploads will fail.
            </Body>
          </Card>
        ) : null}

        {busy ? (
          <Card>
            <View style={styles.busyHeader}>
              <ActivityIndicator color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.busyTitle, { color: colors.text }]}>{headline}</Text>
                <Text style={[styles.busyDetail, { color: colors.muted }]}>{detail}</Text>
              </View>
              <Text style={[styles.percent, { color: colors.accent }]}>
                {Math.round(progress * 100)}%
              </Text>
            </View>
            <View style={{ marginTop: 16 }}>
              <ProgressBar fraction={progress} />
            </View>
          </Card>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose an audio file"
            onPress={pick}
            style={({ pressed }) => [
              styles.dropzone,
              {
                backgroundColor: colors.panel,
                borderColor: picked ? colors.accent : colors.edge,
                opacity: pressed ? 0.85 : 1,
              },
            ]}>
            <View style={[styles.dropIcon, { backgroundColor: `${colors.accent}1a` }]}>
              <Text style={{ color: colors.accent, fontSize: 26 }}>↑</Text>
            </View>
            {picked ? (
              <>
                <Text style={[styles.dropTitle, { color: colors.text }]} numberOfLines={1}>
                  {picked.name}
                </Text>
                <Body muted>{formatBytes(picked.size)} · tap to choose another</Body>
              </>
            ) : (
              <>
                <Text style={[styles.dropTitle, { color: colors.text }]}>Choose an audio file</Text>
                <Body muted>{ACCEPTED_EXTENSIONS.join('  ·  ')} · max 25 MB</Body>
              </>
            )}
          </Pressable>
        )}

        {error ? (
          <Card style={{ borderColor: `${colors.danger}55` }}>
            <Label style={{ color: colors.danger }}>Could not process that file</Label>
            <Body style={{ marginTop: 6 }}>{error}</Body>
          </Card>
        ) : null}

        <Button
          label={busy ? 'Cleaning…' : 'Remove echo'}
          onPress={start}
          disabled={!picked}
          busy={busy}
        />

        <Card>
          <Label>Why this is different</Label>
          <View style={{ gap: 10, marginTop: 10 }}>
            <Benefit text="Zero manual sliders — one tap, no tuning" />
            <Benefit text="Runs in the cloud — nothing to install" />
            <Benefit text="Every job benchmarked against the legacy tools" />
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Benefit({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.rowGap}>
      <Text style={{ color: colors.accent, fontWeight: '800' }}>✓</Text>
      <Body muted style={{ flex: 1 }}>
        {text}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 40 },
  hero: { gap: 8, paddingTop: 8 },
  heroTitle: { fontSize: 26, lineHeight: 32 },
  heroBody: { fontSize: 15 },
  dropzone: {
    alignItems: 'center',
    borderRadius: 22,
    borderStyle: 'dashed',
    borderWidth: 2,
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 36,
  },
  dropIcon: {
    alignItems: 'center',
    borderRadius: 16,
    height: 56,
    justifyContent: 'center',
    marginBottom: 8,
    width: 56,
  },
  dropTitle: { fontSize: 17, fontWeight: '700' },
  busyHeader: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  busyTitle: { fontSize: 16, fontWeight: '700' },
  busyDetail: { fontSize: 13, marginTop: 2 },
  percent: { fontSize: 14, fontWeight: '800' },
  rowGap: { alignItems: 'center', flexDirection: 'row', gap: 8 },
});
