import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import customizationsRoutes from '../../server/routes/customizations';

function app(runHeadless: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }> = async () => ({ text: 'polished md', ok: true })) {
  const f = Fastify();
  f.register(customizationsRoutes, {
    listProviders: async () => [
      { id: 'claude', customizations: {}, commands: { headlessAsk: (cwd: string, p: string) => ['claude', '-p', '--', p] } },
    ] as any,
    resolveRepo: async (id: string) => (id === 'known' ? '/repo' : null),
    runHeadless,
  });
  return f;
}
const post = (f: ReturnType<typeof app>, body: object) =>
  f.inject({ method: 'POST', url: '/api/customizations/assist', payload: body });
const base = { projectId: 'known', provider: 'claude', section: 'skills', name: 'my-skill', draft: 'do stuff' };

describe('POST /api/customizations/assist', () => {
  it('returns the headless result and passes the draft inside the prompt argv element', async () => {
    let argv: string[] = [];
    const f = app(async (a: string[]) => { argv = a; return { text: 'polished md', ok: true }; });
    const res = await post(f, base);
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('polished md');
    expect(argv[argv.length - 1]).toContain('do stuff'); // draft rides in the final argv element, never a shell string
    expect(argv[argv.length - 1]).toContain('SKILL.md'); // prompt teaches the target format
  });
  it('404s unknown project, 400s unknown provider, 400s empty draft', async () => {
    expect((await post(app(), { ...base, projectId: 'nope' })).statusCode).toBe(404);
    expect((await post(app(), { ...base, provider: 'gemini' })).statusCode).toBe(400);
    expect((await post(app(), { ...base, draft: '' })).statusCode).toBe(400);
  });
  it('502s when the agent run fails', async () => {
    const res = await post(app(async () => ({ text: 'boom', ok: false })), base);
    expect(res.statusCode).toBe(502);
  });
});
