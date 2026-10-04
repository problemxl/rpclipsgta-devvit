#!/usr/bin/env python3
"""Prepare disposable Reddit test accounts without automating Reddit signup.

This is a local-only helper.  It creates Guerrilla Mail inboxes, generates
credentials, and optionally displays carefully validated verification-link
candidates.  A person must complete signup at Reddit's normal web UI.

The core uses only the Python standard library. With no command in a real
terminal, the script presents a small interactive text menu; explicit `gen`
and `check` commands remain noninteractive for automation. Neither mode adds a
browser or automates Reddit signup.
"""

from __future__ import annotations

import email.utils
import html
import inspect
import json
from contextlib import contextmanager
from http.cookies import CookieError, SimpleCookie
import os
import re
import secrets
import socket
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence, TextIO

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no fcntl
    fcntl = None  # type: ignore[assignment]


HERE = Path(__file__).resolve().parent
DEFAULT_ACCOUNT_PATH = HERE.parent / "test-accounts.txt"
API_ENDPOINT = "https://api.guerrillamail.com/ajax.php"
API_HOST = "api.guerrillamail.com"
API_TIMEOUT = 15.0
DEFAULT_WAIT = 120
DEFAULT_INTERVAL = 10
MAX_ACCOUNTS = 10
MAX_WAIT = 60 * 60
MAX_INTERVAL = 15 * 60
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_STORE_BYTES = 4 * 1024 * 1024
MAX_MESSAGES = 1000
MAX_MESSAGE_ID = 256

_HEADER = (
    "# r/RPClipsGTA local test accounts — secrets, never commit\n"
    "# one versioned JSON record per account; signup remains manual\n"
)


class HelperError(Exception):
    """Base class for expected helper failures."""


class UsageError(HelperError):
    """Invalid command-line input."""


class AccountFileError(HelperError):
    """Invalid or unsafe account-store data."""


class TransportError(HelperError):
    """A network or HTTP failure talking to Guerrilla Mail."""


class ApiResponseError(HelperError):
    """A malformed or rejected Guerrilla Mail response."""


class PollDeadline(HelperError):
    """The overall check deadline elapsed before another request could start."""


@dataclass
class SessionState:
    """The serializable portion of one Guerrilla Mail session.

    Cookies are deliberately represented as an allowlisted list of plain
    dictionaries.  CookieJar instances are process objects and must never be
    pickled into the credential store.
    """

    sid_token: str
    cookies: list[dict[str, Any]] = field(default_factory=list)
    updated_at: str | None = None


@dataclass
class Account:
    username: str
    password: str
    email: str
    session: SessionState
    seen_message_ids: list[str] = field(default_factory=list)
    verification_urls: list[str] = field(default_factory=list)

    @property
    def sid_token(self) -> str:
        """Compatibility accessor for callers migrating from the JS helper."""

        return self.session.sid_token


@dataclass
class HttpResponse:
    """Transport response used by the production transport."""

    payload: Any
    status: int = 200
    headers: Mapping[str, str] = field(default_factory=dict)
    cookies: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Inbox:
    email: str
    session: SessionState


def _has_control_characters(value: str) -> bool:
    return any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)


def _nonempty_string(value: Any, field_name: str, *, max_length: int = 4096) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > max_length
        or _has_control_characters(value)
        or any(character.isspace() for character in value)
    ):
        raise ApiResponseError(f"Guerrilla Mail response did not contain a valid {field_name}")
    return value


def _safe_text(value: Any) -> str:
    """Return short printable diagnostic text without exposing secrets."""

    text = str(value)
    text = "".join(character if 0x20 <= ord(character) < 0x7f else " " for character in text)
    return text[:160]


_COOKIE_NAME_RE = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}")
_COOKIE_VALUE_RE = re.compile(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}")


def _valid_cookie(cookie: Mapping[str, Any]) -> bool:
    name = cookie.get("name")
    value = cookie.get("value")
    domain = cookie.get("domain", API_HOST)
    path = cookie.get("path", "/")
    expires = cookie.get("expires")
    return (
        isinstance(name, str)
        and _COOKIE_NAME_RE.fullmatch(name) is not None
        and isinstance(value, str)
        and len(value) <= 4096
        and _COOKIE_VALUE_RE.fullmatch(value) is not None
        and isinstance(domain, str)
        and domain.lower() in {API_HOST, f".{API_HOST}"}
        and isinstance(path, str)
        and path.startswith("/")
        and not _has_control_characters(path)
        and (expires is None or (
            isinstance(expires, str) and len(expires) <= 128 and not _has_control_characters(expires)
        ))
        and isinstance(cookie.get("secure", True), bool)
    )


def _is_valid_email_address(value: str) -> bool:
    if not isinstance(value, str) or len(value) > 320 or _has_control_characters(value):
        return False
    if value.count("@") != 1 or any(character.isspace() for character in value):
        return False
    local, domain = value.rsplit("@", 1)
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}", local):
        return False
    if local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    labels = domain.split(".")
    if len(domain) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in labels
    ):
        return False
    return True


def _validate_session(session: SessionState) -> None:
    if (
        not isinstance(session.sid_token, str)
        or not session.sid_token.strip()
        or len(session.sid_token) > 4096
        or _has_control_characters(session.sid_token)
        or any(character.isspace() for character in session.sid_token)
    ):
        raise AccountFileError("session contains an invalid sid_token")
    if session.updated_at is not None and (
        not isinstance(session.updated_at, str)
        or len(session.updated_at) > 64
        or _has_control_characters(session.updated_at)
    ):
        raise AccountFileError("session contains an invalid update time")
    if not isinstance(session.cookies, list):
        raise AccountFileError("session cookies must be a list")
    for cookie in session.cookies:
        if not isinstance(cookie, dict):
            raise AccountFileError("session cookie must be an object")
        allowed = {"name", "value", "domain", "path", "secure", "expires"}
        if set(cookie) - allowed:
            raise AccountFileError("session cookie contains an unsupported field")
        if not _valid_cookie(cookie):
            raise AccountFileError("session contains an invalid cookie")


def validate_account(account: Account) -> None:
    if not isinstance(account, Account):
        raise AccountFileError("account record is not an object")
    if not isinstance(account.username, str) or not re.fullmatch(r"[A-Za-z0-9_-]{3,20}", account.username):
        raise AccountFileError("account has an invalid username")
    if (
        not isinstance(account.password, str)
        or not 8 <= len(account.password) <= 256
        or _has_control_characters(account.password)
    ):
        raise AccountFileError("account has an invalid password")
    if not isinstance(account.email, str) or not _is_valid_email_address(account.email):
        raise AccountFileError("account has an invalid email")
    _validate_session(account.session)
    if not isinstance(account.seen_message_ids, list) or not all(
        isinstance(item, str)
        and 0 < len(item) <= MAX_MESSAGE_ID
        and not _has_control_characters(item)
        for item in account.seen_message_ids
    ):
        raise AccountFileError("account has invalid message ids")
    if not isinstance(account.verification_urls, list) or not all(
        isinstance(item, str) and is_allowed_verification_url(item)
        for item in account.verification_urls
    ):
        raise AccountFileError("account has invalid verification links")


def _session_from_record(record: Mapping[str, Any], line_number: int) -> SessionState:
    session_record = record.get("session")
    if "session" not in record:
        # Migrate the original JSON-lines format without retaining its old
        # camelCase spelling in new writes.
        sid_token = record.get("sidToken", record.get("sid_token"))
        session_record = {"sid_token": sid_token}
    if not isinstance(session_record, dict):
        raise AccountFileError(f"invalid session on line {line_number}")
    sid_token = session_record.get("sid_token", session_record.get("sidToken"))
    if not isinstance(sid_token, str) or not sid_token.strip():
        raise AccountFileError(f"missing sid_token on line {line_number}")
    cookies = session_record.get("cookies", [])
    updated_at = session_record.get("updated_at")
    if not isinstance(cookies, list):
        raise AccountFileError(f"invalid cookies on line {line_number}")
    session = SessionState(sid_token=sid_token, cookies=cookies, updated_at=updated_at)
    try:
        _validate_session(session)
    except (AccountFileError, ApiResponseError) as error:
        raise AccountFileError(f"invalid session on line {line_number}") from error
    return session


def _account_from_record(record: Any, line_number: int) -> Account:
    if not isinstance(record, dict):
        raise AccountFileError(f"invalid account on line {line_number}")
    if "schema_version" in record and record["schema_version"] != 2:
        raise AccountFileError(f"unsupported account schema on line {line_number}")
    required = ("username", "password", "email")
    if any(field not in record for field in required):
        raise AccountFileError(f"missing account field on line {line_number}")
    account = Account(
        username=record["username"],
        password=record["password"],
        email=record["email"],
        session=_session_from_record(record, line_number),
        seen_message_ids=record.get("seen_message_ids", []),
        verification_urls=record.get("verification_urls", []),
    )
    try:
        validate_account(account)
    except AccountFileError as error:
        raise AccountFileError(f"invalid account on line {line_number}") from error
    return account


def load_accounts(path: Path | str = DEFAULT_ACCOUNT_PATH, *, required: bool = True) -> list[Account]:
    """Load versioned JSON-lines or the original helper's JSON-lines format."""

    destination = Path(path)
    try:
        info = destination.lstat()
    except FileNotFoundError:
        if required:
            raise AccountFileError(f"no account store at {destination}; run gen first")
        return []
    except OSError as error:
        raise AccountFileError(f"cannot inspect account store: {_safe_text(error)}") from error
    if not stat_is_regular(info.st_mode):
        raise AccountFileError("account store must be a regular file, not a symlink or directory")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise AccountFileError("account store permissions must be exactly 0600")
    fd: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(destination, flags)
        opened = os.fstat(fd)
        if not stat_is_regular(opened.st_mode) or stat.S_IMODE(opened.st_mode) != 0o600:
            raise AccountFileError("account store must be a regular 0600 file")
        with os.fdopen(fd, "rb") as stream:
            fd = None
            raw = stream.read(MAX_STORE_BYTES + 1)
        if len(raw) > MAX_STORE_BYTES:
            raise AccountFileError("account store is too large")
        text = raw.decode("utf-8")
    except AccountFileError:
        raise
    except (OSError, UnicodeError) as error:
        raise AccountFileError(f"cannot read account store: {_safe_text(error)}") from error
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    accounts: list[Account] = []
    usernames: set[str] = set()
    emails: set[str] = set()
    sessions: set[str] = set()
    for line_number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise AccountFileError(f"invalid JSON on line {line_number}") from error
        account = _account_from_record(record, line_number)
        if account.username in usernames or account.email.lower() in emails or account.sid_token in sessions:
            raise AccountFileError(f"duplicate account on line {line_number}")
        usernames.add(account.username)
        emails.add(account.email.lower())
        sessions.add(account.sid_token)
        accounts.append(account)
    return accounts


def _cookie_record(cookie: Mapping[str, Any]) -> dict[str, Any]:
    record = {
        "name": cookie.get("name"),
        "value": cookie.get("value"),
        "domain": cookie.get("domain", API_HOST),
        "path": cookie.get("path", "/"),
        "secure": bool(cookie.get("secure", True)),
    }
    if cookie.get("expires") is not None:
        record["expires"] = cookie["expires"]
    return record


def _account_record(account: Account) -> dict[str, Any]:
    validate_account(account)
    session = {
        "sid_token": account.session.sid_token,
        "cookies": [_cookie_record(cookie) for cookie in account.session.cookies],
    }
    if account.session.updated_at is not None:
        session["updated_at"] = account.session.updated_at
    return {
        "schema_version": 2,
        "username": account.username,
        "password": account.password,
        "email": account.email,
        "session": session,
        "seen_message_ids": list(dict.fromkeys(account.seen_message_ids)),
        "verification_urls": list(dict.fromkeys(account.verification_urls)),
    }


def stat_is_regular(mode: int) -> bool:
    return bool(mode & 0o170000 == 0o100000)


def _fsync_directory(path: Path) -> None:
    """Make the replacement durable, or report that durability failed."""

    fd: int | None = None
    try:
        fd = os.open(path, os.O_RDONLY)
        os.fsync(fd)
    except OSError as error:
        raise AccountFileError("could not durably sync account store directory") from error
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError as error:
                raise AccountFileError("could not close account store directory") from error


@contextmanager
def account_store_lock(path: Path | str) -> Iterator[None]:
    """Serialize a command's load/update/save transaction on POSIX."""

    destination = Path(path)
    lock_path = Path(f"{destination}.lock")
    fd: int | None = None
    try:
        try:
            existing = lock_path.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat_is_regular(existing.st_mode):
            raise AccountFileError("account store lock must be a regular file")
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(lock_path, flags, 0o600)
        os.fchmod(fd, 0o600)
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    except AccountFileError:
        raise
    except OSError as error:
        raise AccountFileError("could not lock account store") from error
    finally:
        if fd is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
            except OSError as error:
                raise AccountFileError("could not release account store lock") from error


def save_accounts_atomic(path: Path | str, accounts: Iterable[Account]) -> None:
    """Write secrets via same-directory temp file + fsync + atomic replace."""

    destination = Path(path)
    account_list = list(accounts)
    usernames: set[str] = set()
    emails: set[str] = set()
    sessions: set[str] = set()
    records: list[str] = []
    for account in account_list:
        record = _account_record(account)
        if account.username in usernames or account.email.lower() in emails or account.sid_token in sessions:
            raise AccountFileError("duplicate account")
        usernames.add(account.username)
        emails.add(account.email.lower())
        sessions.add(account.sid_token)
        records.append(json.dumps(record, separators=(",", ":"), ensure_ascii=True))
    payload = (_HEADER + "\n".join(records) + ("\n" if records else "")).encode("utf-8")
    if len(payload) > MAX_STORE_BYTES:
        raise AccountFileError("account store is too large")

    try:
        parent = destination.parent
        parent_info = parent.lstat()
        if parent_info.st_mode & 0o170000 == 0o120000:
            raise AccountFileError("account store parent may not be a symlink")
        if not stat_is_regular(parent_info.st_mode) and not (parent_info.st_mode & 0o170000 == 0o40000):
            raise AccountFileError("account store parent is not a directory")
        try:
            existing = destination.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat_is_regular(existing.st_mode):
            raise AccountFileError("refusing to write a symlink or non-regular account store")
    except AccountFileError:
        raise
    except OSError as error:
        raise AccountFileError(f"cannot inspect account store path: {_safe_text(error)}") from error

    temporary = parent / f".{destination.name}.{uuid.uuid4().hex}.tmp"
    fd: int | None = None
    replaced = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o600)
        os.replace(temporary, destination)
        replaced = True
        _fsync_directory(parent)
    except AccountFileError:
        raise
    except (OSError, UnicodeError) as error:
        raise AccountFileError(f"could not safely write account store: {_safe_text(error)}") from error
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if not replaced:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError as error:
                raise AccountFileError("could not remove temporary account store") from error


# ---------------------------------------------------------------------------
# Verification links
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"https://[^\s\"'<>]+", re.IGNORECASE)
_HEX_ESCAPE_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_TRAILING_PUNCTUATION = ".,!;:)]}"
_ALLOWED_PATHS = ("/verify/", "/verification/", "/activate/")
_ALLOWED_REDDIT_SENDERS = {"noreply@reddit.com"}


def is_allowed_verification_url(candidate: str) -> bool:
    """Accept only an HTTPS Reddit verification route, never a redirect target."""

    if not isinstance(candidate, str) or not candidate or len(candidate) > 4096:
        return False
    if any(ord(char) < 0x20 or ord(char) == 0x7f for char in candidate):
        return False
    if any(char.isspace() for char in candidate) or "\\" in candidate or _HEX_ESCAPE_RE.search(candidate):
        return False
    if re.search(r"%(?:2f|5c|3f|23)", candidate, re.IGNORECASE):
        return False
    try:
        parsed = urllib.parse.urlsplit(candidate)
    except ValueError:
        return False
    if (
        parsed.scheme.lower() != "https"
        or "#" in candidate
        or "@" in parsed.netloc
        or ":" in parsed.netloc
    ):
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    if port is not None:  # Even :443 is not needed and is easy to spoof in displays.
        return False
    hostname = parsed.hostname
    if hostname is None or not hostname.isascii() or hostname.lower() not in {"reddit.com", "www.reddit.com"}:
        return False
    path = parsed.path
    if not any(path.lower().startswith(prefix) and len(path) > len(prefix) for prefix in _ALLOWED_PATHS):
        return False
    try:
        decoded_path = urllib.parse.unquote(path, errors="strict")
    except UnicodeDecodeError:
        return False
    if any(ord(character) < 0x20 or ord(character) == 0x7f for character in decoded_path):
        return False
    if (
        not decoded_path.isascii()
        or "%" in decoded_path
        or any(character in decoded_path for character in "\\?#<>")
    ):
        return False
    if "//" in decoded_path or any(segment in {".", ".."} for segment in decoded_path.split("/")):
        return False
    if not any(
        decoded_path.lower().startswith(prefix) and len(decoded_path) > len(prefix)
        for prefix in _ALLOWED_PATHS
    ):
        return False
    if not re.fullmatch(
        r"/(?:verify|verification|activate)/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*",
        decoded_path,
        re.IGNORECASE,
    ):
        return False
    try:
        query_items = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return False
    # Verification queries may contain opaque tokens, but must not contain a
    # nested URL, separators, controls, or a second layer of encoding.
    for name, value in query_items:
        if (
            not name
            or _has_control_characters(name)
            or _has_control_characters(value)
            or any(character.isspace() or character in "/\\?#:%" for character in name + value)
        ):
            return False
    return True


def parse_reddit_verification_links(body: str) -> list[str]:
    decoded = html.unescape(str(body))
    links: list[str] = []
    for raw in _URL_RE.findall(decoded):
        candidate = raw
        while candidate and candidate[-1] in _TRAILING_PUNCTUATION:
            candidate = candidate[:-1]
        if not is_allowed_verification_url(candidate):
            continue
        if candidate not in links:
            links.append(candidate)
    return links


def _is_reddit_sender(value: Any) -> bool:
    """Apply an exact sender-address filter; mail metadata is not authentication."""

    if not isinstance(value, str) or not value or value != value.strip() or _has_control_characters(value):
        return False
    if "," in value or ";" in value:
        return False
    if "<" in value or ">" in value:
        if not re.fullmatch(r"[^<>\r\n]+\s+<[^<>\r\n]+>", value):
            return False
    elif any(character.isspace() for character in value):
        return False
    display, address = email.utils.parseaddr(value)
    if display and "<" not in value:
        return False
    return address.lower() in _ALLOWED_REDDIT_SENDERS


# ---------------------------------------------------------------------------
# Guerrilla Mail client and standard-library transport
# ---------------------------------------------------------------------------

def _remaining_deadline(deadline: float | None, clock: Callable[[], float] = time.monotonic) -> float | None:
    if deadline is None:
        return None
    remaining = deadline - clock()
    if remaining <= 0:
        raise PollDeadline("polling deadline reached")
    return remaining


class UrlLibTransport:
    """Fixed-origin urllib transport with cookies and bounded responses."""

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
            return None

    def __init__(
        self,
        endpoint: str = API_ENDPOINT,
        user_agent: str = "rpclipsgta local account helper",
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        parsed = urllib.parse.urlsplit(endpoint)
        if endpoint != API_ENDPOINT or parsed.scheme != "https" or parsed.netloc != API_HOST or parsed.path != "/ajax.php":
            raise ValueError("Guerrilla Mail endpoint is fixed")
        self.endpoint = endpoint
        self.user_agent = user_agent
        self.clock = clock
        self.opener = urllib.request.build_opener(self._NoRedirect())

    def request(
        self,
        params: Mapping[str, str],
        session: SessionState,
        *,
        timeout: float,
        deadline: float | None = None,
    ) -> HttpResponse:
        query = urllib.parse.urlencode({key: str(value) for key, value in params.items()})
        request = urllib.request.Request(
            f"{self.endpoint}?{query}",
            headers={
                "Accept": "application/json",
                "User-Agent": self.user_agent,
                "Cookie": "; ".join(
                    f"{cookie['name']}={cookie['value']}"
                    for cookie in session.cookies
                    if cookie.get("domain", API_HOST).lstrip(".").lower() == API_HOST
                ),
            },
            method="GET",
        )
        try:
            request_timeout = min(timeout, _remaining_deadline(deadline, self.clock) or timeout)
            with self.opener.open(request, timeout=request_timeout) as response:
                status = int(getattr(response, "status", response.getcode()))
                chunks: list[bytes] = []
                size = 0
                while size <= MAX_RESPONSE_BYTES:
                    remaining = _remaining_deadline(deadline, self.clock)
                    if remaining is not None:
                        _set_socket_timeout(response, remaining)
                    chunk = response.read(min(65536, MAX_RESPONSE_BYTES + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise TransportError("Guerrilla Mail response was too large")
                payload = json.loads(b"".join(chunks).decode("utf-8"))
                headers = {str(key): str(value) for key, value in response.headers.items()}
                cookie_headers = response.headers.get_all("Set-Cookie") or []
                return HttpResponse(
                    payload=payload,
                    status=status,
                    headers=headers,
                    cookies=_parse_set_cookies(cookie_headers),
                )
        except PollDeadline:
            raise
        except socket.timeout as error:
            if deadline is not None and self.clock() >= deadline:
                raise PollDeadline("polling deadline reached") from error
            raise TransportError("Guerrilla Mail request timed out") from error
        except TransportError:
            raise
        except urllib.error.HTTPError as error:
            raise TransportError(f"Guerrilla Mail HTTP failure ({error.code})") from error
        except (urllib.error.URLError, TimeoutError, OSError, UnicodeError, json.JSONDecodeError) as error:
            # Do not include the exception text: urllib errors can echo the
            # full query string, including the sid_token.
            raise TransportError("Guerrilla Mail request failed") from error


def _set_socket_timeout(response: Any, timeout: float) -> None:
    """Bound each response read when urllib exposes its underlying socket."""

    try:
        response.fp.raw._sock.settimeout(timeout)  # type: ignore[attr-defined]
    except AttributeError:
        # Test doubles and alternate urllib implementations may not expose a
        # socket. Their response.read() remains bounded by the opener timeout.
        pass


def _parse_set_cookies(headers: Iterable[str]) -> list[dict[str, Any]]:
    """Parse distinct Set-Cookie fields without corrupting Expires commas."""

    parsed: list[dict[str, Any]] = []
    for header in headers:
        jar = SimpleCookie()
        try:
            jar.load(header)
        except (CookieError, ValueError):
            continue
        for name, morsel in jar.items():
            value = morsel.value
            domain = morsel["domain"] or API_HOST
            path = morsel["path"] or "/"
            cookie = {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
                "secure": bool(morsel["secure"]),
                **({"expires": morsel["expires"]} if morsel["expires"] else {}),
            }
            if not _valid_cookie(cookie):
                continue
            parsed.append(cookie)
    return parsed


class GuerrillaMailClient:
    def __init__(
        self,
        transport: Any | None = None,
        *,
        timeout: float = API_TIMEOUT,
        clock: Callable[[], float] = time.monotonic,
    ):
        if timeout <= 0 or timeout > 120:
            raise ValueError("timeout must be between 0 and 120 seconds")
        self.clock = clock
        self.transport = transport or UrlLibTransport(clock=clock)
        self.timeout = float(timeout)

    def _call(
        self,
        params: Mapping[str, str],
        session: SessionState,
        *,
        deadline: float | None = None,
    ) -> dict[str, Any]:
        operation = str(params.get("f", "operation"))
        try:
            if deadline is not None and self.clock() >= deadline:
                raise PollDeadline("polling deadline reached")
            request_timeout = self.timeout
            request_kwargs: dict[str, Any] = {"timeout": request_timeout}
            if deadline is not None:
                request_kwargs["timeout"] = min(self.timeout, max(0.001, deadline - self.clock()))
                request_kwargs["deadline"] = deadline
            try:
                signature = inspect.signature(self.transport.request)
                accepts_deadline = "deadline" in signature.parameters or any(
                    parameter.kind is inspect.Parameter.VAR_KEYWORD
                    for parameter in signature.parameters.values()
                )
            except (TypeError, ValueError):
                accepts_deadline = True
            if not accepts_deadline:
                request_kwargs.pop("deadline", None)
            response = self.transport.request(params, session, **request_kwargs)
        except PollDeadline:
            raise
        except ApiResponseError:
            raise
        except TransportError as error:
            # Never trust transport exception text: a custom transport may
            # include a URL query or cookie in it.
            raise TransportError(f"Guerrilla Mail {operation} request failed") from error
        except Exception as error:
            # A test transport or socket library may include cookies/tokens in
            # its exception text. Keep diagnostics secret-free.
            raise TransportError(f"Guerrilla Mail {operation} request failed") from error
        response_cookies: list[dict[str, Any]] = []
        if isinstance(response, HttpResponse):
            if not 200 <= response.status < 300:
                raise TransportError(f"Guerrilla Mail HTTP failure ({response.status})")
            body = response.payload
            response_cookies = response.cookies
            if not isinstance(response_cookies, list) or any(
                not isinstance(cookie, dict) or not _valid_cookie(cookie)
                for cookie in response_cookies
            ):
                raise ApiResponseError(f"Guerrilla Mail {operation} returned invalid cookies")
        else:
            body = response
        if not isinstance(body, dict):
            raise ApiResponseError(f"Guerrilla Mail {operation} returned invalid JSON")
        if body.get("error") not in (None, "", False):
            raise ApiResponseError(f"Guerrilla Mail {operation} was rejected")
        rotated = body.get("sid_token")
        if rotated is not None:
            if (
                not isinstance(rotated, str)
                or not rotated.strip()
                or len(rotated) > 4096
                or _has_control_characters(rotated)
                or any(character.isspace() for character in rotated)
            ):
                raise ApiResponseError(f"Guerrilla Mail {operation} returned an invalid session")
            session.sid_token = rotated
        if response_cookies:
            for cookie in response_cookies:
                session.cookies = [existing for existing in session.cookies if existing.get("name") != cookie["name"]]
                session.cookies.append(cookie)
        session.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return body

    def new_inbox(self) -> Inbox:
        session = SessionState("")
        initial = self._call({"f": "get_email_address", "lang": "en"}, session)
        initial_email = _nonempty_string(initial.get("email_addr"), "email_addr", max_length=320)
        if not session.sid_token:
            session.sid_token = _nonempty_string(initial.get("sid_token"), "sid_token")
        local_part = f"rpcl.{secrets.token_hex(5)}"
        assigned = self._call(
            {"f": "set_email_user", "email_user": local_part, "lang": "en", "sid_token": session.sid_token},
            session,
        )
        email_address = assigned.get("email_addr", initial_email)
        if not isinstance(email_address, str) or not email_address.strip():
            email_address = initial_email
        _validate_email_address(email_address)
        return Inbox(email=email_address, session=session)

    def list_messages(self, session: SessionState, *, deadline: float | None = None) -> list[dict[str, Any]]:
        body = self._call(
            {"f": "get_email_list", "offset": "0", "sid_token": session.sid_token},
            session,
            deadline=deadline,
        )
        messages = body.get("list")
        if not isinstance(messages, list):
            raise ApiResponseError("Guerrilla Mail returned an invalid message list")
        if len(messages) > MAX_MESSAGES or any(not isinstance(message, dict) for message in messages):
            raise ApiResponseError("Guerrilla Mail returned an invalid message list")
        return messages

    def fetch_message(
        self, session: SessionState, message_id: str, *, deadline: float | None = None
    ) -> str:
        body = self._call(
            {"f": "fetch_email", "email_id": message_id, "sid_token": session.sid_token},
            session,
            deadline=deadline,
        )
        message_body = body.get("mail_body")
        if not isinstance(message_body, str):
            raise ApiResponseError("Guerrilla Mail returned an invalid message body")
        return message_body

    def check_inbox(self, account: Account, *, deadline: float | None = None) -> list[str]:
        messages = self.list_messages(account.session, deadline=deadline)
        links: list[str] = []
        for message in messages:
            message_id = message.get("mail_id")
            if not isinstance(message_id, (str, int)) or not str(message_id):
                raise ApiResponseError("Guerrilla Mail returned a message without an id")
            message_id = str(message_id)
            if len(message_id) > MAX_MESSAGE_ID or _has_control_characters(message_id):
                raise ApiResponseError("Guerrilla Mail returned an invalid message id")
            sender = message.get("mail_from")
            if not isinstance(sender, str):
                raise ApiResponseError("Guerrilla Mail returned a message without a sender")
            if message_id in account.seen_message_ids:
                continue
            if not _is_reddit_sender(sender):
                # It is safe to remember a non-Reddit message without fetching
                # it; sender metadata is only a cheap filter, never proof.
                account.seen_message_ids.append(message_id)
                continue
            body = self.fetch_message(account.session, message_id, deadline=deadline)
            # Mark only after a successful fetch so a timeout can be retried
            # during a later poll rather than losing the verification mail.
            account.seen_message_ids.append(message_id)
            links.extend(parse_reddit_verification_links(body))
        return list(dict.fromkeys(links))


def _validate_email_address(value: str) -> None:
    if not _is_valid_email_address(value):
        raise ApiResponseError("Guerrilla Mail returned an invalid email address")


# ---------------------------------------------------------------------------
# Credential generation, commands, and terminal UI
# ---------------------------------------------------------------------------


def random_username() -> str:
    return f"rpctest_{secrets.token_hex(4)}"[:20]


def random_password() -> str:
    lowers = "abcdefghijkmnopqrstuvwxyz"
    uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    digits = "23456789"
    symbols = "!#$%&*+-=?@_"
    alphabet = lowers + uppers + digits + symbols
    chars = [
        secrets.choice(lowers),
        secrets.choice(uppers),
        secrets.choice(digits),
        secrets.choice(symbols),
    ]
    while len(chars) < 18:
        chars.append(secrets.choice(alphabet))
    for index in range(len(chars) - 1, 0, -1):
        other = secrets.randbelow(index + 1)
        chars[index], chars[other] = chars[other], chars[index]
    return "".join(chars)


def generate_accounts(
    count: int,
    *,
    client: GuerrillaMailClient,
    account_path: Path | str = DEFAULT_ACCOUNT_PATH,
    stdout: TextIO = sys.stdout,
) -> list[Account]:
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= MAX_ACCOUNTS:
        raise UsageError(f"count must be an integer from 1 to {MAX_ACCOUNTS}")
    created: list[Account] = []
    with account_store_lock(account_path):
        accounts = load_accounts(account_path, required=False)
        existing_usernames = {account.username for account in accounts}
        existing_emails = {account.email.lower() for account in accounts}
        for index in range(count):
            inbox = client.new_inbox()
            username = random_username()
            while username in existing_usernames:
                username = random_username()
            account = Account(username=username, password=random_password(), email=inbox.email, session=inbox.session)
            validate_account(account)
            if account.email.lower() in existing_emails:
                raise HelperError("Guerrilla Mail returned a duplicate inbox; generation stopped")
            accounts.append(account)
            created.append(account)
            existing_usernames.add(account.username)
            existing_emails.add(account.email.lower())
            # Persist after each successful inbox so an interrupted run retains
            # sessions already created. Each update is still atomic and private.
            save_accounts_atomic(account_path, accounts)
            print(f"[{index + 1}/{count}] {account.username}  ·  {account.email}", file=stdout)
    print(f"\nWrote {len(created)} entr{'y' if len(created) == 1 else 'ies'} to {account_path}", file=stdout)
    print("Next: sign up manually at reddit.com/signup using each username, password, and email.", file=stdout)
    print("Then run the check command; this helper never submits signup.", file=stdout)
    return created


def check_accounts(
    wait_seconds: int,
    *,
    interval_seconds: int = DEFAULT_INTERVAL,
    show_links: bool = False,
    client: GuerrillaMailClient,
    account_path: Path | str = DEFAULT_ACCOUNT_PATH,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    if not isinstance(wait_seconds, int) or not 0 <= wait_seconds <= MAX_WAIT:
        raise UsageError(f"wait must be a non-negative integer no greater than {MAX_WAIT}")
    if not isinstance(interval_seconds, int) or not 0 <= interval_seconds <= MAX_INTERVAL:
        raise UsageError(f"interval must be an integer from 0 to {MAX_INTERVAL}")
    # A zero wait is explicitly one immediate poll using the normal request
    # timeout; a positive wait is a hard wall-clock window.
    deadline = None if wait_seconds == 0 else clock() + wait_seconds
    client.clock = clock
    if hasattr(client.transport, "clock"):
        client.transport.clock = clock
    with account_store_lock(account_path):
        accounts = load_accounts(account_path)
        if not accounts:
            print("No accounts to check.", file=stdout)
            return 0
        pending = list(accounts)
        print(f"Polling {len(accounts)} inbox(es) for up to {wait_seconds}s…", file=stdout)
        first_poll = True
        failures = 0
        while pending and (first_poll or (deadline is not None and clock() < deadline)):
            first_poll = False
            next_pending: list[Account] = []
            for account_index, account in enumerate(pending):
                try:
                    links = client.check_inbox(account, deadline=deadline)
                    account.session.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    if links:
                        account.verification_urls = list(dict.fromkeys(account.verification_urls + links))
                        print(f"\n✓ {account.username} <{account.email}>", file=stdout)
                        print("  Candidate verification link(s) found; inspect exact sender and URL manually.", file=stdout)
                        for link in links:
                            print(f"    {_display_verification_url(link, reveal=show_links)}", file=stdout)
                    else:
                        next_pending.append(account)
                except PollDeadline as error:
                    failures += 1
                    print(f"  ! polling stopped before checking {account.email}: {_safe_text(error)}", file=stderr)
                    next_pending.extend(pending[account_index:])
                    break
                except (HelperError, OSError) as error:
                    failures += 1
                    print(f"  ! {account.email}: {_safe_text(error)}", file=stderr)
                    # A failed request is not treated as verified, but do not make
                    # a transient/expired account block every other inbox forever.
                    next_pending.append(account)
            save_accounts_atomic(account_path, accounts)
            pending = next_pending
            if not pending or wait_seconds == 0 or (deadline is not None and clock() >= deadline):
                break
            assert deadline is not None
            remaining = max(0.0, deadline - clock())
            delay = min(float(interval_seconds), remaining)
            if delay <= 0:
                break
            sleep(delay)
    for account in pending:
        print(
            f"  … no Reddit verification mail yet for {account.email} "
            "(the session may have expired; check Guerrilla Mail manually)",
            file=stderr,
        )
    return 1 if failures else 0


def _display_verification_url(url: str, *, reveal: bool) -> str:
    if reveal:
        return url
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "<redacted>", ""))


def parse_command_args(args: Sequence[str]) -> dict[str, Any]:
    """Parse CLI arguments without argparse's permissive abbreviation rules."""

    values = list(args)
    if values and values[0] in {"-h", "--help"}:
        if len(values) > 1:
            raise UsageError("help does not accept arguments")
        return {"command": "help"}
    command = values.pop(0) if values and not values[0].startswith("-") else "gen"
    if values in (["-h"], ["--help"]):
        return {"command": "help"}
    if command == "help":
        if values:
            raise UsageError("help does not accept arguments")
        return {"command": "help"}
    if command not in {"gen", "check", "tui"}:
        raise UsageError(f'unknown command "{command}" — use: gen [count] | check [--wait seconds] | tui')
    result: dict[str, Any] = {"command": command}
    if command == "tui":
        # The shared option loop below permits --store while rejecting polling
        # options, which have no meaning in the menu.
        pass
    elif command == "gen":
        count = 3
        if values and not values[0].startswith("-"):
            raw = values.pop(0)
            if not re.fullmatch(r"\d+", raw):
                raise UsageError(f"count must be an integer from 1 to {MAX_ACCOUNTS}")
            count = int(raw)
        if not 1 <= count <= MAX_ACCOUNTS:
            raise UsageError(f"count must be an integer from 1 to {MAX_ACCOUNTS}")
        result["count"] = count
    elif command == "check":
        result["wait_seconds"] = DEFAULT_WAIT
        result["interval_seconds"] = DEFAULT_INTERVAL
        result["show_links"] = False
    result["store"] = None
    seen: set[str] = set()
    index = 0
    while index < len(values):
        argument = values[index]
        if argument == "--wait" or argument.startswith("--wait="):
            option = "wait"
            if option in seen:
                raise UsageError("duplicate --wait option")
            seen.add(option)
            raw = argument.split("=", 1)[1] if "=" in argument else (values[index + 1] if index + 1 < len(values) else None)
            if "=" not in argument:
                index += 1
            if raw is None or not re.fullmatch(r"\d+", raw):
                raise UsageError("wait must be a non-negative integer")
            number = int(raw)
            if number > MAX_WAIT:
                raise UsageError(f"wait must be a non-negative integer no greater than {MAX_WAIT}")
            if command != "check":
                raise UsageError("--wait is only valid with check")
            result["wait_seconds"] = number
        elif argument == "--interval" or argument.startswith("--interval="):
            option = "interval"
            if option in seen:
                raise UsageError("duplicate --interval option")
            seen.add(option)
            raw = argument.split("=", 1)[1] if "=" in argument else (values[index + 1] if index + 1 < len(values) else None)
            if "=" not in argument:
                index += 1
            if raw is None or not re.fullmatch(r"\d+", raw):
                raise UsageError("interval must be a non-negative integer")
            number = int(raw)
            if number > MAX_INTERVAL:
                raise UsageError(f"interval must be an integer from 0 to {MAX_INTERVAL}")
            if command != "check":
                raise UsageError("--interval is only valid with check")
            result["interval_seconds"] = number
        elif argument == "--show-links":
            if command != "check":
                raise UsageError("--show-links is only valid with check")
            if "show-links" in seen:
                raise UsageError("duplicate --show-links option")
            seen.add("show-links")
            result["show_links"] = True
        elif argument == "--store" or argument.startswith("--store="):
            option = "store"
            if option in seen:
                raise UsageError("duplicate --store option")
            seen.add(option)
            raw = argument.split("=", 1)[1] if "=" in argument else (values[index + 1] if index + 1 < len(values) else None)
            if "=" not in argument:
                index += 1
            if raw is None or not raw or raw.startswith("-"):
                raise UsageError("--store requires a path")
            result["store"] = raw
        else:
            raise UsageError(f"unknown argument \"{argument}\"")
        index += 1
    if result["store"] is None:
        result.pop("store")
    if command != "check":
        result.pop("show_links", None)
    return result


HELP_TEXT = """Usage: python scripts/gen-test-accounts.py [COMMAND] [OPTIONS]

With no command in a terminal, an interactive text menu is shown. Use `tui`
to request that menu explicitly. The menu is standard-library only.

Prepare Guerrilla Mail inboxes and credentials for human-guided Reddit signup.
This tool never signs up for Reddit, uses a Reddit API/browser, bypasses CAPTCHA,
or opens verification links.

Commands:
  gen [COUNT]             Create COUNT accounts (default: 3, range: 1-10).
  check                   Poll saved inboxes for Reddit verification mail.
  tui                     Open the interactive terminal menu.

Options:
  --wait SECONDS         Overall polling window (default: 120, max: 3600).
                         --wait 0 performs one poll with the request timeout.
  --interval SECONDS     Delay between polls (default: 10, max: 900).
                         Zero performs one poll and exits (no busy loop).
  --show-links           Explicitly reveal bearer-like verification URLs.
                         Default output redacts query tokens.
  --store PATH           Private 0600 JSON-lines credential store.
  -h, --help             Show this help.

Exit status:
  0  Completed; no mail before the deadline is not an error.
  1  A network/deadline failure occurred while checking an account.
  2  Invalid command or unsafe/malformed local/API data.

Verification links are validated HTTPS Reddit candidates and are shown for
manual inspection only. They are bearer-like values; protect terminal output.

When no TTY is available, the interactive menu is refused rather than waiting
for input; use an explicit `gen` or `check` command for noninteractive use.
"""


def _stream_is_tty(stream: TextIO) -> bool:
    """Return whether a stream is an interactive terminal without assuming it has isatty."""

    try:
        return bool(stream.isatty())
    except (AttributeError, OSError):
        return False


def _tui_readline(prompt: str, *, stdin: TextIO, stdout: TextIO) -> str | None:
    """Print a prompt and read one line, treating EOF as a normal exit."""

    print(prompt, file=stdout, end="", flush=True)
    try:
        line = stdin.readline()
    except (EOFError, OSError):
        return None
    if line == "":
        return None
    return line.strip()


def _tui_yes_no(prompt: str, *, stdin: TextIO, stdout: TextIO, default: bool = False) -> bool | None:
    """Read a yes/no answer; return None on EOF and keep invalid input local."""

    suffix = "Y/n" if default else "y/N"
    while True:
        answer = _tui_readline(f"{prompt} [{suffix}] ", stdin=stdin, stdout=stdout)
        if answer is None:
            return None
        if not answer:
            return default
        if answer.lower() in {"y", "yes"}:
            return True
        if answer.lower() in {"n", "no"}:
            return False
        print("Please answer yes or no.", file=stdout)


def _tui_integer(
    prompt: str,
    *,
    stdin: TextIO,
    stdout: TextIO,
    default: int,
    minimum: int,
    maximum: int,
) -> int | None:
    """Read a bounded integer from the menu, accepting the displayed default."""

    while True:
        answer = _tui_readline(f"{prompt} [{default}] ", stdin=stdin, stdout=stdout)
        if answer is None:
            return None
        if not answer:
            return default
        if re.fullmatch(r"\d+", answer):
            value = int(answer)
            if minimum <= value <= maximum:
                return value
        print(f"Please enter a number from {minimum} to {maximum}.", file=stdout)


def _tui_generate(
    *,
    client: GuerrillaMailClient,
    account_path: Path | str,
    stdin: TextIO,
    stdout: TextIO,
) -> bool:
    """Generate one account and offer a deliberate, one-shot password reveal."""

    print("\nGenerating one disposable inbox and credential set…", file=stdout)
    created = generate_accounts(1, client=client, account_path=account_path, stdout=stdout)
    account = created[0]
    print("\nGenerated account (signup remains manual):", file=stdout)
    print(f"  Email:    {account.email}", file=stdout)
    print(f"  Username: {account.username}", file=stdout)
    print("  Password: hidden (stored in the private account file)", file=stdout)
    reveal = _tui_yes_no(
        "Confirmation: reveal the password in this terminal? It is a secret and may be captured in terminal logs.",
        stdin=stdin,
        stdout=stdout,
    )
    if reveal:
        print(f"  Password: {account.password}", file=stdout)
    elif reveal is False:
        print("  Password hidden; retrieve it from the private account file when needed.", file=stdout)
    return reveal is not None


def _tui_check(
    *,
    client: GuerrillaMailClient,
    account_path: Path | str,
    stdin: TextIO,
    stdout: TextIO,
    stderr: TextIO,
    clock: Callable[[], float],
    sleep: Callable[[float], None],
) -> bool:
    """Run one human-configured inbox check without opening any links."""

    wait_seconds = _tui_integer(
        "Polling window in seconds (0 = one immediate check)",
        stdin=stdin,
        stdout=stdout,
        default=DEFAULT_WAIT,
        minimum=0,
        maximum=MAX_WAIT,
    )
    if wait_seconds is None:
        return False
    interval_seconds = _tui_integer(
        "Delay between checks in seconds",
        stdin=stdin,
        stdout=stdout,
        default=DEFAULT_INTERVAL,
        minimum=0,
        maximum=MAX_INTERVAL,
    )
    if interval_seconds is None:
        return False
    show_links = _tui_yes_no(
        "Reveal verification URL query tokens? Review links manually; never open them automatically.",
        stdin=stdin,
        stdout=stdout,
    )
    if show_links is None:
        return False
    result = check_accounts(
        wait_seconds,
        interval_seconds=interval_seconds,
        show_links=show_links,
        client=client,
        account_path=account_path,
        stdout=stdout,
        stderr=stderr,
        clock=clock,
        sleep=sleep,
    )
    if result:
        print("Inbox check completed with one or more request/deadline failures.", file=stderr)
    return True


def run_tui(
    *,
    client: GuerrillaMailClient | None = None,
    account_path: Path | str = DEFAULT_ACCOUNT_PATH,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Run the small terminal menu; all external work remains in the core helpers."""

    if client is None:
        client = GuerrillaMailClient()
    print("Local test-account helper", file=stdout)
    print("Manual Reddit signup only; this tool never submits signup or opens links.", file=stdout)
    while True:
        print("\nMenu", file=stdout)
        print("  1) Generate inbox + username + password", file=stdout)
        print("  2) Check inbox for Reddit verification", file=stdout)
        print("  3) Exit", file=stdout)
        choice = _tui_readline("Select an option: ", stdin=stdin, stdout=stdout)
        if choice is None or choice == "3":
            print("\nExit.", file=stdout)
            return 0
        try:
            if choice == "1":
                _tui_generate(client=client, account_path=account_path, stdin=stdin, stdout=stdout)
            elif choice == "2":
                _tui_check(
                    client=client,
                    account_path=account_path,
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                    clock=clock,
                    sleep=sleep,
                )
            else:
                print("Please select 1, 2, or 3.", file=stdout)
        except (HelperError, OSError, ValueError) as error:
            print(f"Failed: {_safe_text(error)}", file=stderr)


def main(
    args: Sequence[str] | None = None,
    *,
    client: GuerrillaMailClient | None = None,
    account_path: Path | str | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    args = list(sys.argv[1:] if args is None else args)
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    try:
        # A bare invocation is the interactive entry point, but must never turn
        # a redirected job into a process waiting forever for input.
        if not args:
            if not (_stream_is_tty(stdin) and _stream_is_tty(stdout)):
                print(
                    "Interactive menu requires a TTY; use --help or an explicit "
                    "non-interactive command (for example: python scripts/gen-test-accounts.py gen).",
                    file=stderr,
                )
                return 2
            path = Path(account_path or DEFAULT_ACCOUNT_PATH)
            return run_tui(
                client=client,
                account_path=path,
                stdin=stdin,
                stdout=stdout,
                stderr=stderr,
                clock=clock,
                sleep=sleep,
            )
        parsed = parse_command_args(args)
        if parsed["command"] == "help":
            print(HELP_TEXT, file=stdout, end="")
            return 0
        path = Path(account_path or parsed.get("store") or DEFAULT_ACCOUNT_PATH)
        if parsed["command"] == "tui":
            if not (_stream_is_tty(stdin) and _stream_is_tty(stdout)):
                print("The tui command requires an interactive TTY; use gen or check for non-interactive use.", file=stderr)
                return 2
            return run_tui(
                client=client,
                account_path=path,
                stdin=stdin,
                stdout=stdout,
                stderr=stderr,
                clock=clock,
                sleep=sleep,
            )
        if client is None:
            client = GuerrillaMailClient()
        if parsed["command"] == "gen":
            generate_accounts(parsed["count"], client=client, account_path=path, stdout=stdout)
        else:
            return check_accounts(
                parsed["wait_seconds"],
                interval_seconds=parsed["interval_seconds"],
                show_links=parsed["show_links"],
                client=client,
                account_path=path,
                stdout=stdout,
                stderr=stderr,
                clock=clock,
                sleep=sleep,
            )
        return 0
    except (HelperError, OSError, ValueError) as error:
        print(f"Failed: {_safe_text(error)}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())