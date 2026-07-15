import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import marketplaceRoutes from '../../server/routes/marketplace';

function app(fetchText: (url: string) => Promise<string>, readSettings?: () => Promise<Record<string, unknown>>) {
  const f = Fastify();
  f.register(marketplaceRoutes, { fetchText, readSettings });
  return f;
}

const skillMd = (desc: string) => `---\nname: foo\ndescription: ${desc}\n---\nbody`;
const agentMd = (desc: string) => `---\ndescription: ${desc}\n---\nbody`;

describe('GET /api/marketplace/browse', () => {
  it('lists skills+agents with parsed descriptions', async () => {
    const tree = {
      tree: [
        { path: 'skills/foo/SKILL.md', type: 'blob' },
        { path: 'skills/foo/scripts/run.sh', type: 'blob' },
        { path: 'agents/baz.md', type: 'blob' },
        { path: 'agents/nested/qux.md', type: 'blob' }, // not top-level, must be excluded
        { path: 'README.md', type: 'blob' },
      ],
    };
    const f = app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/skills-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify(tree);
      }
      if (url === 'https://raw.githubusercontent.com/acme/skills-repo/HEAD/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/skills-repo/HEAD/agents/baz.md') {
        return agentMd('Baz agent desc');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/browse?source=acme/skills-repo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { path: 'skills/foo', name: 'foo', description: 'Foo skill desc', section: 'skills' },
      { path: 'agents/baz.md', name: 'baz', description: 'Baz agent desc', section: 'agents' },
    ]);
  });

  it('400s a bad source', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/browse?source=not-a-source' });
    expect(res.statusCode).toBe(400);
  });

  it('502s when the fetch fails', async () => {
    const f = app(async () => {
      throw new Error('boom');
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/browse?source=acme/fail-repo' });
    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/marketplace/item', () => {
  it('returns files with contents for a skill dir', async () => {
    const tree = {
      tree: [
        { path: 'skills/foo/SKILL.md', type: 'blob' },
        { path: 'skills/foo/scripts/run.sh', type: 'blob' },
        { path: 'skills/bar/SKILL.md', type: 'blob' },
      ],
    };
    const f = app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/item-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify(tree);
      }
      if (url === 'https://raw.githubusercontent.com/acme/item-repo/HEAD/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/item-repo/HEAD/skills/foo/scripts/run.sh') {
        return '#!/bin/sh\necho hi';
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/item?source=acme/item-repo&path=skills/foo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([
      { path: 'skills/foo/SKILL.md', content: skillMd('Foo skill desc') },
      { path: 'skills/foo/scripts/run.sh', content: '#!/bin/sh\necho hi' },
    ]);
  });

  it('400s when the item path has more than 20 files', async () => {
    const tree = {
      tree: Array.from({ length: 21 }, (_, i) => ({ path: `skills/lots/file${i}.txt`, type: 'blob' })),
    };
    const f = app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/lots-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify(tree);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/item?source=acme/lots-repo&path=skills/lots' });
    expect(res.statusCode).toBe(400);
  });

  it('400s when a file exceeds the 256KB cap', async () => {
    const tree = { tree: [{ path: 'skills/big/SKILL.md', type: 'blob' }] };
    const huge = 'a'.repeat(256 * 1024 + 1);
    const f = app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/big-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify(tree);
      }
      if (url === 'https://raw.githubusercontent.com/acme/big-repo/HEAD/skills/big/SKILL.md') {
        return huge;
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/item?source=acme/big-repo&path=skills/big' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/marketplace/sources', () => {
  it('merges defaults + injected settings', async () => {
    const f = app(
      async () => {
        throw new Error('should not be called');
      },
      async () => ({ marketplaceSources: ['acme/custom-skills'] }),
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/sources' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual(['anthropics/skills', 'anthropics/claude-plugins-official', 'acme/custom-skills']);
  });

  it('defaults to just the built-in source when settings has none', async () => {
    const f = app(
      async () => {
        throw new Error('should not be called');
      },
      async () => ({}),
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/sources' });
    expect(res.json().sources).toEqual(['anthropics/skills', 'anthropics/claude-plugins-official']);
  });
});
