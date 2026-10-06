/**
 * History tab — every recording this device has run.
 *
 * Entries outlive their audio: the server keeps the row after the retention
 * sweep deletes the files, so an old job still appears but is marked
 * `Expired` and is no longer tappable for playback.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Button, EmptyState, Pill, PillTone } from '@/components/ui';
import { JobSummary, deleteJob, fetchHistory } from '@/lib/api';
import { confirmDestructive } from '@/lib/confirm';
import { formatBytes, formatClock, formatRelative } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function HistoryScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const page = await fetchHistory();
      setJobs(page.jobs);
      setError(null);
    } catch (caught: any) {
      setError(caught?.message ?? 'Could not load your history.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refresh on focus so a job finished on the Create tab shows up immediately.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const confirmDelete = useCallback(
    (job: JobSummary) => {
      const remove = async () => {
        // Optimistic: drop it locally, restore if the server disagrees.
        const previous = jobs;
        setJobs((current) => current.filter((item) => item.job_id !== job.job_id));
        try {
          await deleteJob(job.job_id);
        } catch (caught: any) {
          setJobs(previous);
          setError(caught?.message ?? 'Could not delete that recording.');
        }
      };

      confirmDestructive({
        title: 'Delete recording?',
        message: `"${job.original_name}" will be removed permanently.`,
        confirmLabel: 'Delete',
        onConfirm: remove,
      });
    },
    [jobs],
  );

  if (loading) {
    return (
      <SafeAreaView edges={['bottom']} style={[styles.centre, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={jobs}
        keyExtractor={(item) => item.job_id}
        contentContainerStyle={jobs.length ? styles.list : styles.listEmpty}
        refreshing={refreshing}
        onRefresh={() => load(true)}
        ListHeaderComponent={
          error ? (
            <View style={[styles.errorBar, { backgroundColor: `${colors.danger}1a`, borderColor: `${colors.danger}55` }]}>
              <Body style={{ color: colors.danger }}>{error}</Body>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            title="Nothing cleaned yet"
            detail="Recordings you run show up here — re-open, compare, and re-export them anytime.">
            <Button
              label="Clean a recording"
              variant="secondary"
              onPress={() => router.push('/')}
              style={{ marginTop: 14 }}
            />
          </EmptyState>
        }
        renderItem={({ item }) => (
          <HistoryRow job={item} onPress={() => router.push(`/job/${item.job_id}`)} onDelete={() => confirmDelete(item)} />
        )}
      />
    </SafeAreaView>
  );
}

function HistoryRow({
  job,
  onPress,
  onDelete,
}: {
  job: JobSummary;
  onPress: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();

  const failed = job.status === 'failed';
  const expired = !failed && !job.files_available;
  const tone: PillTone = failed ? 'danger' : expired ? 'neutral' : 'success';
  const statusText = failed ? 'Failed' : expired ? 'Expired' : 'Done';

  const meta = failed
    ? (job.error ?? 'Processing failed')
    : `${formatClock(job.duration_seconds)} · ${formatBytes(job.size_bytes)}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${job.original_name}, ${statusText}`}
      onPress={onPress}
      onLongPress={onDelete}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.panel, borderColor: colors.edge, opacity: pressed ? 0.85 : 1 },
      ]}>
      <View style={[styles.waveform, { backgroundColor: failed ? `${colors.danger}1a` : `${colors.accent}1a` }]}>
        <Text style={{ color: failed ? colors.danger : colors.accent, fontSize: 18 }}>
          {failed ? '!' : '▮▮▮'}
        </Text>
      </View>

      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
          {job.original_name}
        </Text>
        <Text style={[styles.rowMeta, { color: colors.muted }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>

      <View style={styles.rowRight}>
        <Pill text={statusText} tone={tone} />
        <Text style={[styles.rowWhen, { color: colors.faint }]}>{formatRelative(job.created_at)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  list: { gap: 10, padding: 16, paddingBottom: 40 },
  listEmpty: { flexGrow: 1, justifyContent: 'center', padding: 16 },
  errorBar: { borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 12 },
  row: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  waveform: {
    alignItems: 'center',
    borderRadius: 10,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 12.5 },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  rowWhen: { fontSize: 11 },
});
