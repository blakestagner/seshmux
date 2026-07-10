import type { ProviderId } from '../../lib/client/types';
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
  const { glyph, name } = PROV[provider];
  return (
    <span className={`${styles.badge} ${styles[provider]}`} title={name}>
      {glyph}
      {withName ? ` ${provider}` : ''}
    </span>
  );
}
