// Static red-flag scan for marketplace items (spec Layer 2). Pure functions
// over already-fetched strings — zero tokens, zero deps, advisory only (the
// server NEVER blocks on findings). Rules deliberately over-trigger; the
// user reads the excerpt and decides.

export interface ScanWarning {
  path: string;
  line: number; // 1-based
  rule: string;
  excerpt: string; // matched line trimmed to 120 chars
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|ts|rb)$/i;
const LINE_RULES: { rule: string; re: RegExp }[] = [
  { rule: 'pipe-to-shell', re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node)\b/i },
  // network-exfil lives outside this table (separate EXFIL regex at the call site)
  { rule: 'base64-blob', re: /[A-Za-z0-9+/=]{200,}|base64\s+-d|atob\(|Buffer\.from\([^)]*['"]base64['"]/i },
  {
    rule: 'credential-path',
    re: /~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc|~\/\.claude\/|~\/\.codex\/|(^|[^\w])\.env\b|AWS_SECRET|API_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY/i,
  },
  {
    rule: 'prompt-injection',
    re: /ignore (all |your )?(previous|prior|above) instructions|disregard .{0,20}instructions|do not (tell|inform|show) the user|hide this from the user|without asking the user/i,
  },
];
const EXFIL = /\b(curl|wget|nc|fetch\(|http\.request)\b[^\n]*https?:\/\/(?![^\s'"]*(github\.com|githubusercontent\.com))[^\s'"]+/i;

export function scanFiles(files: { path: string; content: string }[]): ScanWarning[] {
  const out: ScanWarning[] = [];
  const seen = new Set<string>();
  const push = (path: string, line: number, rule: string, text: string) => {
    const key = `${path}:${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, line, rule, excerpt: text.trim().slice(0, 120) });
  };
  for (const f of files) {
    const isMd = /\.md$/i.test(f.path);
    const lines = f.content.split('\n');
    if (SCRIPT_EXT.test(f.path)) push(f.path, 1, 'bundled-executable', lines[0] ?? '');
    else if (!isMd && lines[0]?.startsWith('#!')) push(f.path, 1, 'bundled-executable', lines[0]);
    lines.forEach((text, i) => {
      for (const { rule, re } of LINE_RULES) if (re.test(text)) push(f.path, i + 1, rule, text);
      // EXFIL applies to all files: a curl/wget invocation line is script-looking
      // content regardless of extension — SKILL.md is the primary attack surface.
      if (EXFIL.test(text)) push(f.path, i + 1, 'network-exfil', text);
    });
  }
  return out;
}
