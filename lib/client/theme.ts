// Theme init/toggle, ported from mockup.html lines ~1024-1046.
// Same localStorage key as the pre-hydration script in app/layout.tsx.
const THEME_KEY = 'seshmux-theme';
const LOCK_KEY = 'seshmux-theme-locked';
const ACCENT_KEY = 'seshmux-accent';

export type Theme = 'light' | 'dark';

// Accent is orthogonal to theme: it swaps --accent/--accent-contrast only.
// Unlike theme there's no 'system' concept and no OS-follow — just a plain
// localStorage pair, default 'iris'. Stamped pre-paint by layout.tsx too.
export type Accent = 'teal' | 'iris';

export function applyAccent(a: Accent): void {
  document.documentElement.dataset.accent = a;
  localStorage.setItem(ACCENT_KEY, a);
}

export function currentAccent(): Accent {
  return localStorage.getItem(ACCENT_KEY) === 'teal' ? 'teal' : 'iris';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}

export function currentTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// User explicitly toggled this session — stop following OS scheme changes.
export function toggleTheme(): void {
  localStorage.setItem(LOCK_KEY, '1');
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

// Call once on mount. Applies current theme and wires the OS-follow listener
// (only active while the user hasn't explicitly toggled this session).
export function initTheme(): () => void {
  applyTheme(currentTheme());
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = (e: MediaQueryListEvent) => {
    if (!localStorage.getItem(LOCK_KEY)) applyTheme(e.matches ? 'dark' : 'light');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
