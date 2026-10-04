#!/usr/bin/env node
/**
 * Test-account preparation helper for the r/RPClipsGTA mod tool.
 *
 * What it does (and deliberately does NOT do):
 *   - Generates strong credentials for throwaway Reddit test accounts.
 *   - Pairs each with a disposable Guerrilla Mail inbox (their public API —
 *     https://www.guerrillamail.com/GuerrillaMailAPI.html).
 *   - `check` polls those inboxes for Reddit's verification email and prints
 *     the verification link, so the only manual step is the signup form itself.
 *   - It NEVER touches reddit.com: account creation stays manual and
 *     human-driven (Reddit's User Agreement prohibits automated signups).
 *
 * Usage:
 *   node scripts/gen-test-accounts.mjs gen [count]     # default count 3
 *   node scripts/gen-test-accounts.mjs check [--wait 120]  # poll inboxes (seconds)
 *
 * Output file: test-accounts.txt (gitignored — contains credentials).
 * Guerrilla Mail rotates its domains per session; if Reddit's signup rejects
 * one (some disposable domains are filtered), rerun `gen` for a new address.
 */

import { randomInt, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = join(HERE, '..', 'test-accounts.txt');
const API = 'https://api.guerrillamail.com/ajax.php';
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randomUsername() {
  const suffix = randomBytes(4).toString('hex'); // 8 hex chars
  return `rpctest_${suffix}`.slice(0, 20); // Reddit: 3-20 chars
}

function randomPassword() {
  const lowers = 'abcdefghijkmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!#$%&*+-=?@_';
  const all = lowers + uppers + digits + symbols;
  const pick = (set) => set[randomInt(set.length)];
  // Guarantee one of each class, fill the rest randomly, then shuffle.
  const chars = [pick(lowers), pick(uppers), pick(digits), pick(symbols)];
  while (chars.length < 18) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function guerrilla(params) {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { 'User-Agent': 'rpclipsgta-devvit test helper' } });
  if (!response.ok) {
    throw new Error(`Guerrilla Mail API ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (typeof body === 'object' && body !== null && String(body.error ?? '') !== '') {
    throw new Error(`Guerrilla Mail API error: ${body.error}`);
  }
  return body;
}

/** New Guerrilla Mail session with a random, pronounceable-ish local part. */
async function newInbox() {
  const initial = await guerrilla({ f: 'get_email_address', lang: 'en' });
  const localPart = `rpcl.${randomBytes(5).toString('hex')}`;
  const assigned = await guerrilla({
    f: 'set_email_user',
    email_user: localPart,
    lang: 'en',
    sid_token: initial.sid_token,
  });
  return {
    email: String(assigned.email_addr ?? initial.email_addr),
    sidToken: String(assigned.sid_token ?? initial.sid_token),
  };
}

function loadAccounts({ required = true } = {}) {
  if (!existsSync(ACCOUNTS_FILE)) {
    if (required) {
      console.error(`No ${ACCOUNTS_FILE} — run "gen" first.`);
      process.exitCode = 1;
    }
    return [];
  }
  const lines = readFileSync(ACCOUNTS_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'));
  return lines.map((line, index) => {
    const entry = JSON.parse(line);
    return { ...entry, index: index + 1 };
  });
}

function saveAccounts(accounts) {
  const header =
    '# r/RPClipsGTA mod-tool test accounts — LOCAL SECRETS, never commit\n' +
    '# fields: username / password (for reddit.com signup) · email / sidToken (Guerrilla Mail inbox)\n';
  const body = accounts.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(ACCOUNTS_FILE, `${header}${body}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function generate(count) {
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const inbox = await newInbox();
    const entry = {
      username: randomUsername(),
      password: randomPassword(),
      email: inbox.email,
      sidToken: inbox.sidToken,
    };
    accounts.push(entry);
    console.log(
      `[${i + 1}/${count}] ${entry.username}  ·  ${entry.email}`
    );
  }
  const existing = loadAccounts({ required: false });
  saveAccounts([...existing, ...accounts]);
  console.log(`\nWrote ${accounts.length} entr${accounts.length === 1 ? 'y' : 'ies'} to test-accounts.txt`);
  console.log('Next: sign up manually at reddit.com/signup using each username/password/email,');
  console.log('then run:  node scripts/gen-test-accounts.mjs check');
}

async function checkInbox(entry) {
  const list = await guerrilla({
    f: 'get_email_list',
    offset: 0,
    sid_token: entry.sidToken,
  });
  const mails = Array.isArray(list.list) ? list.list : [];
  const fromReddit = mails.filter((mail) => /reddit/i.test(String(mail.mail_from ?? '')));
  if (fromReddit.length === 0) return [];

  const links = [];
  for (const mail of fromReddit) {
    const detail = await guerrilla({
      f: 'fetch_email',
      email_id: mail.mail_id,
      sid_token: entry.sidToken,
    });
    const body = String(detail.mail_body ?? '');
    // Verification links point at reddit.com and carry a token query param.
    const found = body.match(/https?:\/\/[^"'\s<]*reddit\.com[^"'\s<]*/gi) ?? [];
    links.push(...found);
  }
  return [...new Set(links)];
}

async function check(waitSeconds) {
  const accounts = loadAccounts();
  if (accounts.length === 0) return;
  const deadline = Date.now() + waitSeconds * 1000;
  const pending = new Set(accounts.map((entry) => entry.index));

  console.log(`Polling ${accounts.length} inbox(es) for up to ${waitSeconds}s…`);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const entry of accounts.filter((entry) => pending.has(entry.index))) {
      try {
        const links = await checkInbox(entry);
        if (links.length > 0) {
          console.log(`\n✓ ${entry.username} <${entry.email}>`);
          for (const link of links) console.log(`  verify: ${link}`);
          pending.delete(entry.index);
        }
      } catch (error) {
        console.error(`  ! ${entry.email}: ${error.message}`);
        pending.delete(entry.index); // broken session — don't spin on it
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  for (const index of pending) {
    const entry = accounts.find((entry) => entry.index === index);
    console.error(`  … no Reddit mail yet for ${entry.email} (sid_token may have expired — check the web inbox)`);
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const [command = 'gen', ...rest] = process.argv.slice(2);
const countArg = Number(rest.find((arg) => /^\d+$/.test(arg)) ?? 3);
const waitArg = Number(rest.find((arg) => /^--wait=/.test(arg))?.split('=')[1] ?? 120);

try {
  if (command === 'gen') {
    await generate(Math.max(1, Math.min(10, countArg)));
  } else if (command === 'check') {
    await check(waitArg);
  } else {
    console.error(`Unknown command "${command}" — use: gen [count] | check [--wait=seconds]`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
}
