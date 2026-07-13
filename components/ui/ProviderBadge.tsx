import type { ProviderId } from '../../lib/client/types';
import { showsProviderIdentity, useDetectedProviders } from '../../lib/client/providers';
import styles from './ProviderBadge.module.scss';

// Provider identity map — the single source of glyph + full name. Exported so
// feature code (e.g. Planoff button labels) reuses these instead of redeclaring
// the ✳/⬡ glyphs.
export const PROV: Record<ProviderId, { glyph: string; name: string }> = {
  claude: { glyph: '✳', name: 'Claude Code' },
  codex: { glyph: '⬡', name: 'Codex CLI' },
};

export type ProviderBadgeProps = {
  provider: ProviderId;
  withName?: boolean;
};

export default function ProviderBadge({ provider, withName = false }: ProviderBadgeProps) {
  // Self-hiding on a single-agent machine: every badge would read the same, so it
  // disambiguates nothing. Gated here (not at the ~7 call sites) so every surface
  // that composes the primitive inherits it.
  const detected = useDetectedProviders();
  if (!showsProviderIdentity(detected)) return null;

  const { glyph, name } = PROV[provider];
  return (
    <span className={`${styles.badge} ${styles[provider]}`} title={name}>
      {glyph}
      {withName ? ` ${provider}` : ''}
    </span>
  );
}
