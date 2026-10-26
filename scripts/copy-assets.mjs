import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/migrations', { recursive: true });
cpSync('src/migrations', 'dist/migrations', { recursive: true });
cpSync('openapi.yaml', 'dist/openapi.yaml');
