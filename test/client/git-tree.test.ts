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
