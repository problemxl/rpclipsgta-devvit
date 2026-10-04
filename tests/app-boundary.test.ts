import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const APP_ENTRY = join(SOURCE_ROOT, 'main.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : extname(path) === '.ts'
        ? [path]
        : [];
  });
}

function staticModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /^\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  const sideEffectPattern = /^\s*import\s*['"]([^'"]+)['"]/gm;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const pattern of [fromPattern, sideEffectPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isWithin(directory: string, path: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith('..') && !pathFromDirectory.startsWith('/'));
}

function resolveLocalImport(importer: string, specifier: string): string {
  const requested = resolve(dirname(importer), specifier);
  const candidates = [
    requested,
    requested.replace(/\.js$/u, '.ts'),
    join(requested, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error(`Cannot resolve ${specifier} imported by ${importer}`);
  return resolved;
}

function appImportGraph(): { files: string[]; externalSpecifiers: string[] } {
  const pending = [APP_ENTRY];
  const visited = new Set<string>();
  const externalSpecifiers = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of staticModuleSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        externalSpecifiers.add(specifier);
        continue;
      }
      const imported = resolveLocalImport(file, specifier);
      if (!isWithin(SOURCE_ROOT, imported)) {
        throw new Error(`App import escapes src/: ${file} -> ${specifier}`);
      }
      pending.push(imported);
    }
  }
  return { files: [...visited], externalSpecifiers: [...externalSpecifiers] };
}

const FORBIDDEN_APP_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['Guerrilla Mail or another mail provider', /guerrilla\s*mail|guerrillamail/i],
  ['email logic', /\b(?:e-?mail)\b/i],
  ['mail protocol', /\b(?:smtp|imap|pop3)\b/i],
  ['mail client', /\b(?:nodemailer|sendgrid|mailgun|mailjet|postmark)\b/i],
  ['outbound fetch call', /\bfetch\s*\(/i],
  [
    'Node network or subprocess module',
    /from\s+['"]node:(?:http|https|net|tls|dgram|dns|child_process)['"]/i,
  ],
  ['subprocess invocation', /\b(?:require|exec|execFile|spawn|fork)\s*\(/i],
  ['Devvit HTTP permission', /\bhttp\s*:\s*(?:\{|true\b|false\b)/i],
  [
    'credentials or app settings',
    /\b(?:password|api[_-]?key|bearer|secret)\b|\b(?:Devvit\.)?(?:addSettings|settings\.get)|\bisSecret\b/i,
  ],
];

function appBoundaryViolations(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN_APP_PATTERNS) {
      if (pattern.test(contents)) violations.push(`${label}: ${file}`);
    }
  }
  return violations;
}

describe('Devvit app boundary', () => {
  it('keeps the entry dependency graph local to src and free of mail/HTTP clients', () => {
    const graph = appImportGraph();
    const allSource = sourceFiles(SOURCE_ROOT);

    expect(graph.files).toContain(APP_ENTRY);
    expect(graph.files.every((file) => isWithin(SOURCE_ROOT, file))).toBe(true);
    expect(graph.files.some((file) => file.includes(`${resolve(REPOSITORY_ROOT, 'scripts')}/`))).toBe(
      false
    );
    expect(graph.externalSpecifiers).toEqual(['@devvit/public-api']);
    expect(appBoundaryViolations(allSource)).toEqual([]);
    expect(
      allSource.some((file) => /gen-test-accounts|scripts\/|test-accounts\.txt|Guerrilla/i.test(readFileSync(file, 'utf8')))
    ).toBe(false);

    const manifest = readFileSync(join(REPOSITORY_ROOT, 'devvit.yaml'), 'utf8');
    expect(manifest).not.toMatch(/guerrilla|smtp|imap|pop3|nodemailer|mailgun|sendgrid/i);
    expect(manifest).not.toMatch(/\bhttp\s*:/i);
  });

  it('does not add a mail or generic HTTP client to the app dependency set', () => {
    const packageJson = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(Object.values(packageJson.scripts ?? {}).join('\n')).not.toMatch(
      /gen-test-accounts|guerrilla|smtp|imap|pop3|python .*test-account/i
    );
    const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
    const forbiddenRuntimeDependency =
      /(?:mail|email|smtp|imap|pop3|fetch|axios|got|request|http|https)/i;

    expect(runtimeDependencies.filter((name) => forbiddenRuntimeDependency.test(name))).toEqual(
      []
    );
    expect(runtimeDependencies).toEqual(['@devvit/public-api']);

    const lockfile = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8')
    ) as { packages?: Record<string, unknown> };
    const lockedMailPackages = Object.keys(lockfile.packages ?? {}).filter((name) =>
      /(?:mail|email|smtp|imap|pop3|nodemailer|sendgrid|mailgun|mailjet|postmark|guerrilla)/i.test(
        name
      )
    );
    expect(lockedMailPackages).toEqual([]);
  });
});
