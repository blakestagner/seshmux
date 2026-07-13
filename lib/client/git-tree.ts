// Pure helpers for the changes panel: fold flat git path lists into a nested
// tree and compute the default-collapsed set (everything except paths that
// lead to a change). Pure so they're unit-testable without React.
import type { FileChange } from './api';

export interface TreeNode {
  path: string; // full repo-relative path
  name: string; // last segment
  children: TreeNode[]; // empty for files
  change?: FileChange;
}

export function buildTree(tree: string[], files: FileChange[]): TreeNode[] {
  const changeByPath = new Map(files.map((f) => [f.path, f]));
  // Deleted files vanish from ls-files but must still show in the panel.
  const allPaths = [...new Set([...tree, ...files.map((f) => f.path)])];

  const root: TreeNode = { path: '', name: '', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);

  const dirFor = (dirPath: string): TreeNode => {
    const hit = dirs.get(dirPath);
    if (hit) return hit;
    const idx = dirPath.lastIndexOf('/');
    const parent = dirFor(idx === -1 ? '' : dirPath.slice(0, idx));
    const node: TreeNode = { path: dirPath, name: dirPath.slice(idx + 1), children: [] };
    parent.children.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  for (const p of allPaths) {
    const idx = p.lastIndexOf('/');
    const parent = dirFor(idx === -1 ? '' : p.slice(0, idx));
    parent.children.push({ path: p, name: p.slice(idx + 1), children: [], change: changeByPath.get(p) });
  }

  // Dir-ness by node IDENTITY, not path lookup: a deleted file can share its
  // path with a new directory of the same name (both nodes legitimately
  // exist), and a path-keyed check would sort the file node among the dirs.
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = dirs.get(a.path) === a ? 0 : 1;
      const bDir = dirs.get(b.path) === b ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** Dir paths whose subtree contains NO change — the panel's initial collapsed set. */
export function collapsedByDefault(nodes: TreeNode[]): Set<string> {
  const collapsed = new Set<string>();
  const hasChange = (n: TreeNode): boolean => {
    if (n.change) return true;
    // map, not some — some() short-circuits and would skip siblings after the
    // first changed subtree, leaving them wrongly expanded.
    const any = n.children.map(hasChange).includes(true);
    if (n.children.length > 0 && !any) collapsed.add(n.path);
    return any;
  };
  for (const n of nodes) hasChange(n);
  return collapsed;
}
