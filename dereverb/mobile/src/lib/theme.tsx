/**
 * theme.tsx
 * =========
 *
 * Light/dark theming for the whole app.
 *
 * Three modes are supported — `system` (follow the OS), `light`, and `dark` —
 * and the choice is persisted so it survives a relaunch. Colour tokens mirror
 * the web dashboard so the product reads as one brand across surfaces.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Palette {
  bg: string;
  panel: string;
  panelAlt: string;
  edge: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accent2: string;
  onAccent: string;
  success: string;
  danger: string;
  warning: string;
}

const DARK: Palette = {
  bg: '#070b14',
  panel: '#0e1626',
  panelAlt: '#121d31',
  edge: '#1d2a40',
  text: '#e2e8f0',
  muted: '#94a3b8',
  faint: '#64748b',
  accent: '#22d3ee',
  accent2: '#818cf8',
  onAccent: '#06121c',
  success: '#34d399',
  danger: '#fb7185',
  warning: '#fbbf24',
};

const LIGHT: Palette = {
  bg: '#f6f8fb',
  panel: '#ffffff',
  panelAlt: '#f1f5f9',
  edge: '#e2e8f0',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  accent: '#0891b2',
  accent2: '#6366f1',
  onAccent: '#ffffff',
  success: '#059669',
  danger: '#e11d48',
  warning: '#d97706',
};

const STORAGE_KEY = 'echostrip.themeMode';

interface ThemeContextValue {
  mode: ThemeMode;
  /** The theme actually in effect once `system` is resolved. */
  scheme: 'light' | 'dark';
  colors: Palette;
  setMode: (mode: ThemeMode) => void;
  /** False until the stored preference has been read, to avoid a flash. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (active && (stored === 'light' || stored === 'dark' || stored === 'system')) {
          setModeState(stored);
        }
      })
      .catch(() => {
        // A missing or unreadable preference is not an error: fall back to
        // `system`, which is already the initial state.
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Persisting is best-effort; the in-memory choice still applies now.
    });
  }, []);

  const scheme: 'light' | 'dark' =
    mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, scheme, colors: scheme === 'dark' ? DARK : LIGHT, setMode, ready }),
    [mode, scheme, setMode, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
