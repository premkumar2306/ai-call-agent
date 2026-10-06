/**
 * Root layout.
 *
 * Wraps the whole app in the theme provider and configures audio so playback
 * is audible even when an iPhone's ringer switch is set to silent — without
 * that, a user tapping play on their cleaned file would hear nothing.
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { setAudioModeAsync } from 'expo-audio';
import { useEffect } from 'react';
import { View } from 'react-native';

import { ThemeProvider, useTheme } from '@/lib/theme';

function Shell() {
  const { colors, scheme, ready } = useTheme();

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      // Non-fatal: playback still works, just not with the ringer switch off.
    });
  }, []);

  // Hold the first paint until the stored theme is known, so the app never
  // flashes light before switching to the user's chosen dark.
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '800' },
          contentStyle: { backgroundColor: colors.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="job/[id]" options={{ title: 'Result', presentation: 'card' }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
