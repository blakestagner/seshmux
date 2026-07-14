'use client';

import { useState } from 'react';
import type { SubagentDetail as SubagentDetailData } from '../../lib/client/types';
import StatusDot from '../ui/StatusDot/StatusDot';
import IconButton from '../ui/IconButton/IconButton';
import Button from '../ui/Button/Button';
import { renderMarkdown } from '../Transcript/Transcript';
import { renderOutcomeBlocks, type OutcomeBlock } from '../../lib/client/subagent-outcome';
import styles from '../SubagentViewer/SubagentViewer.module.scss';

export interface SubagentDetailProps {
  detail: SubagentDetailData | null; // null = loading (or errored, see `error`)
  error?: boolean;
  onRetry?: () => void;
  onBack: () => void;
}

const PROMPT_CLAMP_LINES = 12;

function OutcomeBlockView({ block }: { block: OutcomeBlock }) {
  switch (block.kind) {
    case 'markdown':
      return (
        <div
          className={styles.outcomeBlock}
          // eslint-disable-next-line react/no-danger -- renderMarkdown escapes HTML before parsing (XSS-safe)
          dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
        />
      );
    case 'files':
      return (
        <div className={`${styles.outcomeBlock} ${styles.files}`}>
          {block.files.map((f, i) => (
            <span key={i} className={styles.fileChip}>
              ◦ {f}
            </span>
          ))}
        </div>
      );
    case 'badge':
      return (
        <div className={styles.outcomeBlock}>
          <span className={`${styles.badge} ${block.ok ? styles.badgeOk : styles.badgeFail}`}>
            {block.ok ? '✓' : '✕'}
            <span className={styles.badgeLabel}>{block.label}</span>
          </span>
        </div>
      );
    case 'prose':
      return <div className={`${styles.outcomeBlock} ${styles.prose}`}>{block.text}</div>;
    case 'pre':
      return (
        <pre className={`${styles.outcomeBlock} ${styles.rawPre}`}>{block.text}</pre>
      );
    default:
      return null;
  }
}

export default function SubagentDetail({ detail, error, onRetry, onBack }: SubagentDetailProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  if (detail === null) {
    return (
      <div className={styles.detail}>
        {error ? (
          <div className={styles.loading}>
            Failed to load subagent detail. <Button onClick={() => onRetry?.()}>Retry</Button>
          </div>
        ) : (
          <div className={styles.loading}>Loading…</div>
        )}
      </div>
    );
  }

  const { node, prompt, activity, outcome } = detail;
  const dotStatus = node.status === 'running' ? 'live' : node.status === 'error' ? 'neutral' : 'done';
  const durText =
    node.startedAt != null && node.endedAt != null
      ? (() => {
          const totalSec = Math.round(Math.max(0, node.endedAt! - node.startedAt!) / 1000);
          const min = Math.floor(totalSec / 60);
          const sec = totalSec % 60;
          return min > 0 ? `${min}m${sec}s` : `${sec}s`;
        })()
      : null;

  const promptLines = prompt.split('\n');
  const promptIsLong = promptLines.length > PROMPT_CLAMP_LINES;
  const outcomeBlocks = renderOutcomeBlocks(outcome);
  const recentActivity = activity.slice(-20);

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <div className={styles.backRow}>
          <IconButton label="Back" onClick={onBack}>
            ‹ back
          </IconButton>
          <span className={styles.title}>{node.label}</span>
        </div>
        <div className={styles.metaRow}>
          <StatusDot status={dotStatus} pulse={node.status === 'running'} />
          {node.status === 'error' ? <span className={styles.errorGlyph}>✕</span> : null}
          {node.model ? <span className={styles.segment}>{node.model}</span> : null}
          {node.tokens != null ? <span className={styles.segment}>{(node.tokens / 1000).toFixed(1)}k tok</span> : null}
          {node.toolCalls != null ? <span className={styles.segment}>{node.toolCalls} tool calls</span> : null}
          {durText ? <span className={styles.segment}>{durText}</span> : null}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>PROMPT</div>
        <div className={`${styles.prompt} ${!promptExpanded && promptIsLong ? styles.promptClamped : ''}`}>{prompt}</div>
        {promptIsLong ? (
          <button type="button" className={styles.showMore} onClick={() => setPromptExpanded((v) => !v)}>
            {promptExpanded ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>ACTIVITY</div>
        {recentActivity.map((a, i) => (
          <div key={i} className={styles.activityRow}>
            <span className={styles.activityTool}>{a.tool}</span>
            <span className={styles.activitySummary}>{a.summary}</span>
          </div>
        ))}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>OUTCOME</div>
        {outcomeBlocks.map((block, i) => (
          <OutcomeBlockView key={i} block={block} />
        ))}
        <button type="button" className={styles.rawToggle} onClick={() => setRawOpen((v) => !v)}>
          {rawOpen ? 'Hide raw JSON' : 'Show raw JSON'}
        </button>
        {rawOpen ? <pre className={styles.rawPre}>{outcome.raw}</pre> : null}
      </div>
    </div>
  );
}
