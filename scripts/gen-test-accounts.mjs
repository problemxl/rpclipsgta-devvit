#!/usr/bin/env node
/**
 * Test-account preparation helper for the r/RPClipsGTA mod tool.
 *
 * What it does (and deliberately does NOT do):
 *   - Generates strong credentials for throwaway Reddit test accounts.
 *   - Pairs each with a disposable Guerrilla Mail inbox.
 *   - `check` polls those inboxes for Reddit's verification email and prints
 *     only the verification link; signup itself remains manual.
 *   - It NEVER touches reddit.com: automated Reddit signup is intentionally
 *     out of scope.
 *
 * Usage:
 *   node scripts/gen-test-accounts.mjs gen [count]       # default count 3
 *   node scripts/gen-test-accounts.mjs check [--wait seconds]
 *   node scripts/gen-test-accounts.mjs check [--wait=seconds]
 *
 * Output file: test-accounts.txt (gitignored and mode 0600; contains secrets).
 */

import { randomBytes, randomInt } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = join(HERE, '..', 'test-accounts.txt');
const API = 'https://api.guerrillamail.com/ajax.php';
const POLL_INTERVAL_MS = 10_000;
const API_TIMEOUT_MS = 15_000;
const MAX_ACCOUNTS = 10;
const MAX_WAIT_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randomUsername() {
  const suffix = randomBytes(4).toString('hex');
  return `rpctest_${suffix}`.slice(0, 20);
}

function randomPassword() {
  const lowers = 'abcdefghijkmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!#$%&*+-=?@_';
  const all = lowers + uppers + digits + symbols;
  const pick = (set) => set[randomInt(set.length)];
  const chars = [pick(lowers), pick(uppers), pick(digits), pick(symbols)];
  while (chars.length < 18) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
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
  const response = await fetch(url, {
    headers: { 'User-Agent': 'rpclipsgta-devvit test helper' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Guerrilla Mail API ${response.status} ${response.statusText}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Guerrilla Mail API returned invalid JSON: ${error.message}`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('Guerrilla Mail API returned an invalid response');
  }
  if (String(body.error ?? '') !== '') {
    throw new Error(`Guerrilla Mail API error: ${body.error}`);
  }
  return body;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Guerrilla Mail response did not contain ${field}`);
  }
  return value;
}

/** New Guerrilla Mail session with a random local part. */
async function newInbox() {
  const initial = await guerrilla({ f: 'get_email_address', lang: 'en' });
  const sidToken = requiredString(initial.sid_token, 'sid_token');
  const initialEmail = requiredString(initial.email_addr, 'email_addr');
  const localPart = `rpcl.${randomBytes(5).toString('hex')}`;
  const assigned = await guerrilla({
    f: 'set_email_user',
    email_user: localPart,
    lang: 'en',
    sid_token: sidToken,
  });
  return {
    email: typeof assigned.email_addr === 'string' ? assigned.email_addr : initialEmail,
    sidToken: requiredString(assigned.sid_token ?? sidToken, 'sid_token'),
  };
}

function loadAccounts({ required = true } = {}) {
  if (!existsSync(ACCOUNTS_FILE)) {
    if (required) throw new Error(`No ${ACCOUNTS_FILE} — run "gen" first.`);
    return [];
  }
  const lines = readFileSync(ACCOUNTS_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'));
  return lines.map((line, index) => {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid account on line ${index + 1}`);
    for (const field of ['username', 'password', 'email', 'sidToken']) {
      requiredString(entry[field], `${field} in test-accounts.txt`);
    }
    return { ...entry, index: index + 1 };
  });
}

function saveAccounts(accounts) {
  const header =
    '# r/RPClipsGTA mod-tool test accounts — LOCAL SECRETS, never commit\n' +
    '# fields: username / password (for manual reddit.com signup) · email / sidToken (Guerrilla Mail)\n';
  const body = accounts.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(ACCOUNTS_FILE, `${header}${body}\n`, { mode: 0o600 });
  // writeFileSync's mode is ignored for an existing file; enforce it every time.
  chmodSync(ACCOUNTS_FILE, 0o600);
}

/**
 * Decode the small HTML entity used for query separators and return only exact
 * HTTPS reddit.com links. URL parsing avoids accepting evilreddit.com or
 * reddit.com.evil.example, which a substring regex would incorrectly accept.
 */
export function parseRedditVerificationLinks(body) {
  const decoded = body
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&#x26;/gi, '&');
  const candidates = decoded.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const links = [];
  for (const candidate of candidates) {
    const withoutPunctuation = candidate.replace(/[.,!?;:)\]}]+$/g, '');
    let parsed;
    try {
      parsed = new URL(withoutPunctuation);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== 'https:' ||
      (parsed.hostname.toLowerCase() !== 'reddit.com' &&
        parsed.hostname.toLowerCase() !== 'www.reddit.com')
    ) {
      continue;
    }
    const link = parsed.toString();
    // URL#toString adds a trailing slash to bare paths; preserve the email's
    // link spelling while still normalizing HTML entities and URL validity.
    const normalized = link.endsWith('/') && !/[/?#]/.test(withoutPunctuation.slice(-1))
      ? withoutPunctuation
      : link;
    if (!links.includes(normalized)) links.push(normalized);
  }
  return links;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export function parseCommandArgs(args) {
  const [command = 'gen', ...rest] = args;
  if (command !== 'gen' && command !== 'check') {
    throw new Error(`unknown command "${command}" — use: gen [count] | check [--wait seconds]`);
  }

  if (command === 'gen') {
    if (rest.length > 1 || (rest[0] !== undefined && !/^\d+$/.test(rest[0]))) {
      throw new Error('count must be an integer from 1 to 10');
    }
    const count = rest.length === 0 ? 3 : Number(rest[0]);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ACCOUNTS) {
      throw new Error('count must be an integer from 1 to 10');
    }
    return { command, count };
  }

  let waitSeconds = 120;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    let value;
    if (arg === '--wait') {
      value = rest[++i];
    } else if (arg.startsWith('--wait=')) {
      value = arg.slice('--wait='.length);
    } else {
      throw new Error(`unknown argument "${arg}" — use: check [--wait seconds]`);
    }
    if (value === undefined || !/^\d+$/.test(value)) {
      throw new Error('wait must be a non-negative integer');
    }
    waitSeconds = Number(value);
    if (!Number.isSafeInteger(waitSeconds) || waitSeconds > MAX_WAIT_SECONDS) {
      throw new Error('wait must be a non-negative integer no greater than 3600');
    }
  }
  return { command, waitSeconds };
}

async function generate(count) {
  const accounts = [];
  for (let i = 0; i < count; i += 1) {
    const inbox = await newInbox();
    const entry = {
      username: randomUsername(),
      password: randomPassword(),
      email: inbox.email,
      sidToken: inbox.sidToken,
    };
    accounts.push(entry);
    console.log(`[${i + 1}/${count}] ${entry.username}  ·  ${entry.email}`);
  }
  const existing = loadAccounts({ required: false });
  saveAccounts([...existing, ...accounts]);
  console.log(`\nWrote ${accounts.length} entr${accounts.length === 1 ? 'y' : 'ies'} to test-accounts.txt`);
  console.log('Next: sign up manually at reddit.com/signup using each username/password/email,');
  console.log('then run: node scripts/gen-test-accounts.mjs check');
}

async function checkInbox(entry) {
  const list = await guerrilla({
    f: 'get_email_list',
    offset: 0,
    sid_token: entry.sidToken,
  });
  const mails = Array.isArray(list.list) ? list.list : [];
  const fromReddit = mails.filter((mail) => /reddit/i.test(String(mail.mail_from ?? '')));
  const links = [];
  for (const mail of fromReddit) {
    const detail = await guerrilla({
      f: 'fetch_email',
      email_id: mail.mail_id,
      sid_token: entry.sidToken,
    });
    links.push(...parseRedditVerificationLinks(String(detail.mail_body ?? '')));
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
    for (const entry of accounts.filter((candidate) => pending.has(candidate.index))) {
      try {
        const links = await checkInbox(entry);
        if (links.length > 0) {
          console.log(`\n✓ ${entry.username} <${entry.email}>`);
          for (const link of links) console.log(`  verify: ${link}`);
          pending.delete(entry.index);
        }
      } catch (error) {
        console.error(`  ! ${entry.email}: ${error.message}`);
        pending.delete(entry.index);
      }
    }
    if (pending.size > 0 && Date.now() < deadline) {
      const delay = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  for (const index of pending) {
    const entry = accounts.find((candidate) => candidate.index === index);
    console.error(`  … no Reddit mail yet for ${entry.email} (sid_token may have expired — check the web inbox)`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseCommandArgs(args);
  if (parsed.command === 'gen') await generate(parsed.count);
  else await check(parsed.waitSeconds);
}

const invokedPath = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  }
}
