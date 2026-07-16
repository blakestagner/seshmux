'use client';

import type { SubagentNode } from '../../lib/client/types';
import StatusDot from '../ui/StatusDot/StatusDot';
import styles from '../SubagentViewer/SubagentViewer.module.scss';

export interface SubagentTreeProps {
  nodes: SubagentNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsedIds: Set<string>; // caller-owned
  onToggleCollapse: (id: string) => void;
}

function formatDuration(startedAt: number | null, endedAt: number | null): string | null {
  if (startedAt == null || endedAt == null) return null;
  const ms = Math.max(0, endedAt - startedAt);
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m${sec}s` : `${sec}s`;
}

function Row({
  node,
  depth,
  hasChildren,
  collapsed,
  selected,
  onSelect,
  onToggleCollapse,
}: {
  node: SubagentNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const dotStatus = node.status === 'running' ? 'live' : node.status === 'error' ? 'neutral' : 'done';
  const durText = formatDuration(node.startedAt, node.endedAt);

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={() => onSelect(node.id)}
    >
      {hasChildren ? (
        <button
          type="button"
          className={styles.caret}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(node.id);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className={styles.caretSpacer} />
      )}
      <StatusDot status={dotStatus} pulse={node.status === 'running'} />
      {node.status === 'error' ? <span className={styles.errorGlyph}>✕</span> : null}
      <span className={styles.label}>{node.label}</span>
      {node.model ? (
        <>
          <span className={styles.sep}>·</span>
          <span className={styles.segment}>{node.model}</span>
        </>
      ) : null}
      {node.tokens != null ? (
        <>
          <span className={styles.sep}>·</span>
          <span className={styles.segment}>{(node.tokens / 1000).toFixed(1)}k tok</span>
        </>
      ) : null}
      {durText ? (
        <>
          <span className={styles.sep}>·</span>
          <span className={styles.segment}>{durText}</span>
        </>
      ) : null}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  childrenByParent,
  ancestors,
  selectedId,
  collapsedIds,
  onSelect,
  onToggleCollapse,
}: {
  node: SubagentNode;
  depth: number;
  childrenByParent: Map<string | null, SubagentNode[]>;
  ancestors: Set<string>; // ids on the path from root to this node (excludes this node)
  selectedId: string | null;
  collapsedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  // Cycle guard (S4-2): drop any child that revisits an ancestor (or this node itself) so a
  // malformed parentId cycle can't infinitely recurse into a stack overflow. Such a child
  // renders flat wherever it first legitimately appears; the back-edge is simply not drawn.
  const children = (childrenByParent.get(node.id) ?? []).filter(
    (c) => c.id !== node.id && !ancestors.has(c.id),
  );
  const hasChildren = children.length > 0;
  const childAncestors = new Set(ancestors).add(node.id);
  const collapsed = collapsedIds.has(node.id);

  return (
    <>
      <Row
        node={node}
        depth={depth}
        hasChildren={hasChildren}
        collapsed={collapsed}
        selected={selectedId === node.id}
        onSelect={onSelect}
        onToggleCollapse={onToggleCollapse}
      />
      {hasChildren && !collapsed
        ? children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              ancestors={childAncestors}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onSelect={onSelect}
              onToggleCollapse={onToggleCollapse}
            />
          ))
        : null}
    </>
  );
}

export default function SubagentTree({ nodes, selectedId, onSelect, collapsedIds, onToggleCollapse }: SubagentTreeProps) {
  const ids = new Set(nodes.map((n) => n.id));
  // Root = parentId null OR parent not present in this node set.
  const roots = nodes.filter((n) => n.parentId == null || !ids.has(n.parentId));

  const childrenByParent = new Map<string | null, SubagentNode[]>();
  for (const n of nodes) {
    if (roots.includes(n)) continue;
    const list = childrenByParent.get(n.parentId as string) ?? [];
    list.push(n);
    childrenByParent.set(n.parentId as string, list);
  }

  // Group roots by `group` (workflow phaseTitle), preserving first-seen order.
  // Nodes with group === null render ungrouped, interleaved in original order.
  const groupOrder: (string | null)[] = [];
  const rootsByGroup = new Map<string | null, SubagentNode[]>();
  for (const r of roots) {
    if (!rootsByGroup.has(r.group)) {
      rootsByGroup.set(r.group, []);
      groupOrder.push(r.group);
    }
    rootsByGroup.get(r.group)!.push(r);
  }

  const totalTokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0);

  return (
    <div className={styles.tree}>
      {groupOrder.map((group) => (
        <div key={group ?? '__ungrouped__'} className={styles.group}>
          {group !== null ? <div className={styles.groupHead}>{group}</div> : null}
          {rootsByGroup.get(group)!.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              childrenByParent={childrenByParent}
              ancestors={new Set()}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onSelect={onSelect}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      ))}
      <div className={styles.footer}>
        {nodes.length} agent{nodes.length === 1 ? '' : 's'} · {(totalTokens / 1000).toFixed(1)}k tok
      </div>
    </div>
  );
}
