import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the tracing root to this repo; a stray lockfile in $HOME otherwise
  // makes Next infer the wrong workspace root for standalone file tracing.
  outputFileTracingRoot: __dirname,
};
