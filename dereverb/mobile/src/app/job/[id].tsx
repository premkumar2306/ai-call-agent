/**
 * Job detail — the result screen.
 *
 * Shows the measured benchmarks for this file, an Original vs Cleaned A/B
 * pair, the Competitor Comparison Matrix, and export/delete actions.
 *
 * The two players are deliberately exclusive: starting one pauses the other,
 * because the whole point is comparing the same moment in each version.
 */
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Button, Card, EmptyState, FONT_MONO, Label, Pill, Title } from '@/components/ui';
import { JobDetail, absoluteUrl, deleteJob, fetchJob } from '@/lib/api';
import { confirmDestructive } from '@/lib/confirm';
import { formatBytes, formatClock, formatDuration } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    if (!id) return;
    fetchJob(id)
      .then((detail) => active && setJob(detail))
      .catch((caught: any) => active && setError(caught?.message ?? 'Could not load that job.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  const exportFile = useCallback(async () => {
    if (!job) return;
    setExporting(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setError('Sharing is not available on this device.');
        return;
      }
      // Download into the cache first: the share sheet needs a local file.
      const target = new Directory(Paths.cache, 'echostrip');
      if (!target.exists) target.create({ intermediates: true });
      const downloaded = await File.downloadFileAsync(absoluteUrl(job.urls.download), target);
      await Sharing.shareAsync(downloaded.uri, {
        mimeType: 'audio/wav',
        dialogTitle: 'Save cleaned audio',
      });
    } catch (caught: any) {
      setError(caught?.message ?? 'Could not export that file.');
    } finally {
      setExporting(false);
    }
  }, [job]);

  const confirmDelete = useCallback(() => {
    if (!job) return;
    const run = async () => {
      try {
        await deleteJob(job.job_id);
        router.back();
      } catch (caught: any) {
        setError(caught?.message ?? 'Could not delete that recording.');
      }
    };
    confirmDestructive({
      title: 'Delete recording?',
      message: `"${job.original_name}" will be removed permanently.`,
      confirmLabel: 'Delete',
      onConfirm: run,
    });
  }, [job, router]);

  if (loading) {
    return (
      <View style={[styles.centre, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!job) {
    return (
      <View style={{ backgroundColor: colors.bg, flex: 1 }}>
        <EmptyState title="Not found" detail={error ?? 'That recording is no longer in your history.'} />
      </View>
    );
  }

  const payload = job.payload;
  const benchmark = payload?.benchmark;

  return (
    <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.bg, flex: 1 }}>
      <Stack.Screen options={{ title: job.original_name }} />
      <ScrollView contentContainerStyle={styles.content}>
        {job.status === 'failed' ? (
          <Card style={{ borderColor: `${colors.danger}55` }}>
            <Pill text="Failed" tone="danger" />
            <Body style={{ marginTop: 10 }}>{job.error ?? 'Processing failed.'}</Body>
          </Card>
        ) : null}

        {error ? (
          <Card style={{ borderColor: `${colors.danger}55` }}>
            <Body style={{ color: colors.danger }}>{error}</Body>
          </Card>
        ) : null}

        {benchmark ? (
          <View style={styles.statGrid}>
            <Stat label="File size" value={`${payload!.original.size_mb.toFixed(2)} MB`} caption={`${formatClock(payload!.original.duration_seconds)} of audio`} />
            <Stat label="Processing" value={formatDuration(benchmark.total_seconds)} caption={`model ${formatDuration(benchmark.enhance_seconds)}`} />
            <Stat label="Speed ratio" value={`${benchmark.speed_ratio.toFixed(1)}×`} caption="realtime" accent />
            <Stat
              label="Engine"
              value={engineName(job.engine)}
              caption="zero sliders · 1 tap"
              small
            />
          </View>
        ) : null}

        {job.files_available ? (
          <>
            <PlayerCard title="Original" badge="reverberant" url={absoluteUrl(job.urls.original)} />
            <PlayerCard title="Cleaned" badge="echo stripped" url={absoluteUrl(job.urls.cleaned)} accent />
          </>
        ) : job.status === 'done' ? (
          <Card>
            <Pill text="Expired" />
            <Body muted style={{ marginTop: 10 }}>
              The audio for this recording has passed its retention window and was deleted from
              the server. The entry stays here for your records.
            </Body>
          </Card>
        ) : null}

        {job.files_available ? (
          <View style={styles.actions}>
            <Button label="Export cleaned WAV" onPress={exportFile} busy={exporting} style={{ flex: 1 }} />
          </View>
        ) : null}

        {payload?.matrix ? <MatrixCard matrix={payload.matrix} /> : null}

        <Button label="Delete recording" variant="danger" onPress={confirmDelete} />
      </ScrollView>
    </SafeAreaView>
  );
}

/** `DeepFilterNet3 (cli)` -> `DeepFilterNet3`; the variant is an ops detail. */
function engineName(engine: string | null): string {
  if (!engine) return '—';
  return engine.replace(/\s*\(.*\)\s*$/, '').trim() || engine;
}

function Stat({
  label,
  value,
  caption,
  accent,
  small,
}: {
  label: string;
  value: string;
  caption: string;
  accent?: boolean;
  /** Use a smaller value font for long text such as the engine name. */
  small?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.stat,
        { backgroundColor: colors.panel, borderColor: accent ? `${colors.accent}55` : colors.edge },
      ]}>
      <Label>{label}</Label>
      <Text
        style={[
          styles.statValue,
          small ? styles.statValueSmall : null,
          { color: accent ? colors.accent : colors.text },
        ]}
        numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statCaption, { color: colors.faint }]} numberOfLines={1}>
        {caption}
      </Text>
    </View>
  );
}

/** One audio player with play/pause and a position read-out. */
function PlayerCard({
  title,
  badge,
  url,
  accent,
}: {
  title: string;
  badge: string;
  url: string;
  accent?: boolean;
}) {
  const { colors } = useTheme();
  const player = useAudioPlayer({ uri: url });
  const status = useAudioPlayerStatus(player);

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause();
    } else {
      // Replaying from the end should start over, not sit at the tail.
      if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
        player.seekTo(0);
      }
      player.play();
    }
  }, [player, status.playing, status.currentTime, status.duration]);

  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <Card accent={accent}>
      <View style={styles.playerHeader}>
        <View style={[styles.dot, { backgroundColor: accent ? colors.accent : colors.faint }]} />
        <Label style={{ color: accent ? colors.accent : colors.faint }}>{title}</Label>
        <View style={{ flex: 1 }} />
        <Pill text={badge} tone={accent ? 'accent' : 'neutral'} />
      </View>

      <View style={styles.playerRow}>
        <Button
          label={status.playing ? '❚❚' : '▶'}
          onPress={toggle}
          variant={accent ? 'primary' : 'secondary'}
          style={styles.playButton}
        />
        <View style={{ flex: 1, gap: 6 }}>
          <View style={[styles.track, { backgroundColor: colors.edge }]}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, progress * 100)}%`, backgroundColor: accent ? colors.accent : colors.muted },
              ]}
            />
          </View>
          <Text style={[styles.time, { color: colors.faint, fontFamily: FONT_MONO }]}>
            {formatClock(status.currentTime)} / {formatClock(status.duration)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/**
 * Competitor Comparison Matrix, laid out as stacked cards rather than a table —
 * a wide table does not survive a phone screen.
 */
function MatrixCard({ matrix }: { matrix: NonNullable<JobDetail['payload']>['matrix'] }) {
  const { colors } = useTheme();
  return (
    <Card>
      <Title style={{ fontSize: 17 }}>Competitor Comparison Matrix</Title>
      <Body muted style={{ marginTop: 4 }}>
        Your file, measured here — projected against the legacy de-reverb workflow.
      </Body>

      <View style={styles.badgeWrap}>
        <Pill text={matrix.edge.speed_headline} tone="accent" uppercase={false} />
        <Pill text={matrix.edge.workflow_headline} tone="success" uppercase={false} />
      </View>

      <View style={{ gap: 10, marginTop: 14 }}>
        {matrix.rows.map((row) => (
          <View
            key={row.key}
            style={[
              styles.matrixRow,
              {
                backgroundColor: row.is_self ? `${colors.accent}12` : colors.panelAlt,
                borderColor: row.is_self ? `${colors.accent}55` : colors.edge,
              },
            ]}>
            <View style={styles.matrixHead}>
              <Text
                style={[styles.matrixTool, { color: row.is_self ? colors.accent : colors.text }]}
                numberOfLines={1}>
                {row.tool}
              </Text>
              <Pill text={row.measured ? 'measured' : 'estimate'} tone={row.measured ? 'success' : 'neutral'} />
            </View>
            <Text style={[styles.matrixCategory, { color: colors.faint }]}>{row.category}</Text>

            <View style={styles.matrixGrid}>
              <MatrixCell label="Speed" value={row.speed_label} />
              <MatrixCell label="Machine time" value={row.machine_time} />
              <MatrixCell label="Hands-on" value={row.operator_time} />
              <MatrixCell label="Price" value={row.price} />
            </View>
            <Text style={[styles.matrixControls, { color: colors.muted }]}>
              {row.manual_controls}
            </Text>
          </View>
        ))}
      </View>

      <View style={{ gap: 6, marginTop: 14 }}>
        {matrix.notes.map((note, index) => (
          <Text key={index} style={[styles.note, { color: colors.faint }]}>
            — {note}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function MatrixCell({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.matrixCell}>
      <Text style={[styles.matrixCellLabel, { color: colors.faint }]}>{label}</Text>
      <Text style={[styles.matrixCellValue, { color: colors.text }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  content: { gap: 14, padding: 16, paddingBottom: 40 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: {
    borderRadius: 14,
    borderWidth: 1,
    flexGrow: 1,
    flexBasis: '46%',
    gap: 4,
    padding: 12,
  },
  statValue: { fontSize: 19, fontWeight: '800' },
  statValueSmall: { fontSize: 14.5 },
  statCaption: { fontSize: 11 },
  playerHeader: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  playerRow: { alignItems: 'center', flexDirection: 'row', gap: 14, marginTop: 14 },
  playButton: { minHeight: 46, paddingHorizontal: 0, width: 58 },
  track: { borderRadius: 999, height: 6, overflow: 'hidden', width: '100%' },
  fill: { borderRadius: 999, height: '100%' },
  time: { fontSize: 11 },
  actions: { flexDirection: 'row', gap: 10 },
  badgeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  matrixRow: { borderRadius: 14, borderWidth: 1, gap: 4, padding: 12 },
  matrixHead: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  matrixTool: { flexShrink: 1, fontSize: 15, fontWeight: '800' },
  matrixCategory: { fontSize: 11 },
  matrixGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  matrixCell: { flexBasis: '45%', flexGrow: 1, gap: 2 },
  matrixCellLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  matrixCellValue: { fontSize: 13, fontWeight: '600' },
  matrixControls: { fontSize: 12, marginTop: 8 },
  note: { fontSize: 10.5, lineHeight: 15 },
});
