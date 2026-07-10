'use client';

import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import ProviderBadge, { PROV } from './ui/ProviderBadge';
import Button from './ui/Button';
import MetaLine from './ui/MetaLine';
import { getTranscript, startSession, bridgeHandoff, bridgeReview } from '../lib/client/api';
import type { Msg, Ctx, BridgeStart } from '../lib/client/api';
import type { ProviderId } from '../lib/client/types';
import { useAppState } from '../lib/client/store';
import styles from './Transcript.module.scss';

// Ported from mockup.html renderTranscript() (~1624). Header: title, meta
// chips, actions (Resume — stub until Phase 3, Copy session id — real).
// Messages: user/assistant, collapsible tool-call rows, markdown for
// assistant text.

// Markdown safety: raw HTML in a message must never execute. marked (v5+)
// has no `sanitize` option and passes raw HTML through untouched, so we
// escape HTML entities BEFORE handing the string to marked — markdown syntax
// still parses normally, but any `<script>`/`<img onerror>` renders as
// literal escaped text instead of live markup.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Markdown link syntax `[x](javascript:...)` survives entity-escaping (it's
// not raw HTML, marked builds the href itself) — a custom link renderer
// whitelists safe URL schemes so that path stays closed too.
const safeRenderer = new marked.Renderer();
safeRenderer.link = function linkRenderer(token) {
  const href = (token.href ?? '').trim();
  const safeHref = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
  const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
  return `<a href="${escapeHtml(safeHref)}"${title} rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
};
marked.use({ renderer: safeRenderer });

export function renderMarkdown(text: string): string {
  return marked.parse(escapeHtml(text), { async: false, breaks: true }) as string;
}

const WINDOW_SIZE = 200;

function ToolCall({ tool }: { tool: Msg['tools'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${styles.toolcall} ${open ? styles.open : ''}`}>
      <button type="button" className={styles.toolcallHead} onClick={() => setOpen((o) => !o)}>
        <span className={styles.caret}>▶</span>
        <span className={styles.toolName}>{tool.name}</span>
        <span className={styles.argPreview}>{tool.input}</span>
      </button>
      {open ? <div className={styles.toolcallBody}>{tool.output}</div> : null}
    </div>
  );
}

function Message({ msg }: { msg: Msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`${styles.msg} ${isUser ? styles.user : styles.assistant}`}>
      {/* Role tag is visually hidden — the card tint (user) / accent dot
          (assistant) is the visual cue; this keeps the role in the a11y tree. */}
      <div className={styles.role}>{msg.role}</div>
      {isUser ? null : <span className={styles.dot} aria-hidden="true" />}
      <div className={styles.content}>
        {isUser ? (
          // User text is a plain React text node — NEVER routed through markdown.
          // Assistant text is markdown-rendered; that asymmetry is the XSS boundary.
          <div className={styles.body}>{msg.text}</div>
        ) : (
          <div
            className={styles.body}
            // eslint-disable-next-line react/no-danger -- markdown escaped to plain entities above; no raw HTML passthrough
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
          />
        )}
        {msg.tools.map((tool, i) => (
          <ToolCall key={i} tool={tool} />
        ))}
      </div>
    </div>
  );
}

export type TranscriptProps = {
  projectId: string;
  sessionId: string;
  title: string;
  provider?: ProviderId;
};

export default function Transcript({ projectId, sessionId, title, provider }: TranscriptProps) {
  const { state, dispatch } = useAppState();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [ctx, setCtx] = useState<Ctx>(null);
  const [visible, setVisible] = useState(WINDOW_SIZE);
  const [copied, setCopied] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [bridging, setBridging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const project = state.projects.find((p) => p.id === projectId);
  // The bridge always targets the OPPOSITE provider (mockup: labels flip by
  // source provider). Buttons say "Continue in ⬡ Codex" from a claude session.
  const sourceProvider = provider ?? project?.provider ?? 'claude';
  const otherProvider: ProviderId = sourceProvider === 'codex' ? 'claude' : 'codex';
  const other = PROV[otherProvider];

  async function handleResume() {
    if (!project) return;
    setResuming(true);
    setActionError(null);
    try {
      const { tabMeta } = await startSession({
        projectPath: project.path,
        provider: provider ?? project.provider,
        mode: 'new',
        resumeId: sessionId,
      });
      // Convert THIS transcript tab into a live term in place (same tab id).
      dispatch({ type: 'resumeToTerm', tabId: 'tab-' + sessionId, ptyId: tabMeta.ptyId });
    } catch (e) {
      setResuming(false); // stay on the transcript on failure
      setActionError((e as Error).message || 'resume failed');
    }
  }

  async function runBridge(start: (p: string, s: string) => Promise<BridgeStart>) {
    if (!project || bridging) return;
    setBridging(true);
    try {
      const { ptyId, tabMeta, provider: target } = await start(projectId, sessionId);
      // Open the spawned opposite-provider session as a LINKED term tab — the
      // linked/linkedKind/linkSrc from tabMeta drive the bridge-pair rendering
      // (shared accent bar + ⇄ connector) and block-locked DnD in Tabs.
      dispatch({
        type: 'openTerm',
        ptyId,
        projectId,
        label: project.name,
        provider: target,
        linked: tabMeta.linked ?? true,
        linkedKind: tabMeta.linkedKind,
        linkSrc: tabMeta.linkSrc ?? sessionId,
      });
    } catch (e) {
      // stay on the transcript; error renders inline under the actions row
      setActionError((e as Error).message || 'bridge failed');
    } finally {
      setBridging(false);
    }
  }

  useEffect(() => {
    setMsgs(null);
    setVisible(WINDOW_SIZE);
    getTranscript(projectId, sessionId).then((data) => {
      setMsgs(data.msgs);
      setCtx(data.ctx);
    });
  }, [projectId, sessionId]);

  const shown = useMemo(() => (msgs ? msgs.slice(Math.max(0, msgs.length - visible)) : []), [msgs, visible]);
  const hiddenCount = msgs ? msgs.length - shown.length : 0;

  function copySessionId() {
    navigator.clipboard.writeText(sessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className={styles.transcript}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.meta}>
            {provider ? <ProviderBadge provider={provider} withName /> : null}
            <MetaLine left={ctx ? `${Math.round(ctx.tokens / 1000)}k/${Math.round(ctx.window / 1000)}k tokens · ${ctx.pct}%` : 'no context data'} />
          </div>
          <div className={styles.actions}>
            <Button variant="primary" disabled={resuming || !project} onClick={handleResume}>
              ↻ Resume session
            </Button>
            {!state.tabs.some((t) => t.linked && t.linkedKind === 'handoff' && t.linkSrc === sessionId) ? (
              <Button disabled={bridging || !project} onClick={() => runBridge(bridgeHandoff)}>
                ⇄ Continue in {other.glyph} {otherProvider}
              </Button>
            ) : null}
            <Button disabled={bridging || !project} onClick={() => runBridge(bridgeReview)}>
              ⊙ Review with {other.glyph} {otherProvider}
            </Button>
            <Button onClick={copySessionId}>{copied ? 'Copied' : 'Copy session id'}</Button>
          </div>
          {actionError ? <div className={styles.actionError}>{actionError}</div> : null}
        </div>

        {msgs === null ? (
          <div className={styles.loading}>Loading transcript…</div>
        ) : msgs.length === 0 ? (
          <div className={styles.loading}>No messages in this transcript.</div>
        ) : (
          <>
            {hiddenCount > 0 ? (
              <button type="button" className={styles.loadMore} onClick={() => setVisible((v) => v + WINDOW_SIZE)}>
                Load {Math.min(WINDOW_SIZE, hiddenCount)} earlier messages ({hiddenCount} hidden)
              </button>
            ) : null}
            {shown.map((m, i) => (
              <Message key={i} msg={m} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
