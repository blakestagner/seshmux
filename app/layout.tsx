import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import '../styles/globals.scss';

// Redesign typefaces. `variable` exposes a CSS custom property that tokens.scss
// wires into --sans / --mono (keeping the system fallback chain there).
const hankenGrotesk = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hanken-grotesk',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata = {
  title: 'seshmux — mission control',
  description: 'Local-first mission control for AI coding agents',
};

// Render at REQUEST time, not build time. The per-process auth token below is
// read from process.env at render — a static prerender (the default) would bake
// in the build-time value (empty), leaving the prod app with no token → every
// /api/* + WS call 401s. force-dynamic makes the token script read the live env.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${hankenGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.dataset.theme = localStorage.getItem('seshmux-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');document.documentElement.dataset.accent = localStorage.getItem('seshmux-accent') || 'iris';`,
          }}
        />
        {/* Per-process auth token (Task 6.5): embedded server-side so the client can send
            it on every /api/* + WS call. JSON.stringify keeps it a safe string literal. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__SESHMUX_TOKEN=${JSON.stringify(process.env.SESHMUX_TOKEN || '')};`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
