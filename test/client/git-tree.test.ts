import { describe, it, expect } from 'vitest';
import { buildTree, collapsedByDefault, type TreeNode } from '../../lib/client/git-tree';

const files = [{ path: 'src/lib/a.ts', added: 3, removed: 1, status: 'M' }];
const tree = ['README.md', 'src/lib/a.ts', 'src/lib/b.ts', 'src/other/c.ts', 'zz.txt'];

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => n.name);
}

describe('buildTree', () => {
  it('nests by directory, dirs first then alpha', () => {
    const nodes = buildTree(tree, files);
    expect(names(nodes)).toEqual(['src', 'README.md', 'zz.txt']);
    const src = nodes[0];
    expect(names(src.children)).toEqual(['lib', 'other']);
    expect(names(src.children[0].children)).toEqual(['a.ts', 'b.ts']);
  });

  it('attaches changes to their files', () => {
    const nodes = buildTree(tree, files);
    const a = nodes[0].children[0].children[0];
    expect(a.path).toBe('src/lib/a.ts');
    expect(a.change).toMatchObject({ added: 3, removed: 1 });
    expect(nodes[0].children[0].children[1].change).toBeUndefined();
  });

  it('includes changed files missing from the tree list (deleted files)', () => {
    const nodes = buildTree(['kept.txt'], [{ path: 'gone.txt', added: 0, removed: 5, status: 'D' }]);
    expect(names(nodes)).toEqual(['gone.txt', 'kept.txt']);
  });
});

describe('collapsedByDefault', () => {
  it('collapses only dirs whose subtree has no change', () => {
    const nodes = buildTree(tree, files);
    const collapsed = collapsedByDefault(nodes);
    expect(collapsed.has('src')).toBe(false); // on the changed path
    expect(collapsed.has('src/lib')).toBe(false);
    expect(collapsed.has('src/other')).toBe(true);
  });

  it('collapses everything when nothing changed', () => {
    const collapsed = collapsedByDefault(buildTree(tree, []));
    expect(collapsed.has('src')).toBe(true);
    expect(collapsed.has('src/lib')).toBe(true);
  });
});

describe('deleted file vs new directory with the same name (review fix)', () => {
  it('keeps both nodes and sorts the true dir among dirs', () => {
    const nodes = buildTree(
      ['config/app.ts', 'zz.txt'],
      [{ path: 'config', added: 0, removed: 5, status: 'D' }],
    );
    const configNodes = nodes.filter((n) => n.path === 'config');
    expect(configNodes).toHaveLength(2);
    const dir = configNodes.find((n) => n.children.length > 0)!;
    const file = configNodes.find((n) => n.children.length === 0)!;
    expect(dir.children[0].path).toBe('config/app.ts');
    expect(file.change?.status).toBe('D');
    expect(nodes[0]).toBe(dir); // dir sorts first
  });
});

// Ignored dirs arrive from git as a single trailing-slash entry (`node_modules/`)
// and their contents are fetched only on expand — the node must still look and
// sort like a directory while it has no children, and start collapsed.
describe('lazy (ignored) dirs', () => {
  it('renders a trailing-slash entry as an empty dir node marked lazy', () => {
    const nodes = buildTree(['a.ts', 'node_modules/', '.env'], []);
    expect(names(nodes)).toEqual(['node_modules', '.env', 'a.ts']); // dir first
    const nm = nodes[0];
    expect(nm.lazy).toBe(true);
    expect(nm.children).toEqual([]);
    expect(collapsedByDefault(nodes).has('node_modules')).toBe(true);
  });

  // Regression: an ignored dir can ALSO hold a force-added tracked file, so it
  // arrives with a child already. The panel must still treat it as unexpanded
  // (it gates the fetch on lazy, not on children.length) or it shows the one
  // tracked file and silently hides the rest of the directory.
  it('stays lazy when a tracked file already lives inside the ignored dir', () => {
    const nodes = buildTree(['dist/', 'dist/keep.js', 'src/a.ts'], []);
    const dist = nodes.find((n) => n.path === 'dist')!;
    expect(dist.lazy).toBe(true);
    expect(names(dist.children)).toEqual(['keep.js']);
  });

  it('does not duplicate a dir listed both with and without its slash', () => {
    const nodes = buildTree(['a/', 'a/', 'a/b.txt'], []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].lazy).toBe(true);
    expect(names(nodes[0].children)).toEqual(['b.txt']);
  });

  it('keeps the lazy flag once children are merged in', () => {
    const nodes = buildTree(['node_modules/', 'node_modules/pkg/', 'node_modules/x.js'], []);
    const nm = nodes[0];
    expect(nm.lazy).toBe(true);
    expect(names(nm.children)).toEqual(['pkg', 'x.js']);
    expect(nm.children[0].lazy).toBe(true);
  });
});
