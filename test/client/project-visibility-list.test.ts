import { describe, it, expect } from 'vitest';
import { visibleProjects } from '../../components/ProjectVisibilityList/ProjectVisibilityList';
import type { Project } from '../../lib/client/types';

const proj = (over: Partial<Project>): Project => ({
  id: over.id ?? 'p', provider: 'claude', name: over.name ?? 'proj',
  path: over.path ?? '/x', sessionCount: 0, createdAt: 0, updatedAt: 0,
  missing: false, ...over,
});

describe('visibleProjects', () => {
  it('keeps non-missing projects', () => {
    expect(visibleProjects([proj({ id: 'a' }), proj({ id: 'b' })]).map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('drops missing projects', () => {
    expect(visibleProjects([proj({ id: 'a' }), proj({ id: 'b', missing: true })]).map((p) => p.id)).toEqual(['a']);
  });
  it('empty in → empty out', () => {
    expect(visibleProjects([])).toEqual([]);
  });
});
