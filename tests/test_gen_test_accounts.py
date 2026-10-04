"""Offline tests for the local test-account preparation helper."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "gen-test-accounts.py"
SPEC = importlib.util.spec_from_file_location("gen_test_accounts", MODULE_PATH)
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = helper
SPEC.loader.exec_module(helper)


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, params, session, *, timeout, deadline=None):
        self.calls.append((dict(params), session.sid_token, timeout, deadline))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class AccountHelperTests(unittest.TestCase):
    def test_verification_parser_decodes_entities_and_rejects_lookalikes(self):
        body = """
        <a href="https://www.reddit.com/verification/abc?token=one&amp;foo=two">verify</a>
        https://reddit.com/verify/abc?token=one&amp;foo=two.
        https://reddit.com.evil.example/verification/phish
        https://evilreddit.com/verification/phish
        https://example.com/?next=https://reddit.com/verification/phish
        https://reddit.com@evil.example/verify/phish
        https://reddit.com:8443/verify/phish
        https://reddit.com/ordinary-page
        """
        self.assertEqual(
            helper.parse_reddit_verification_links(body),
            [
                "https://www.reddit.com/verification/abc?token=one&foo=two",
                "https://reddit.com/verify/abc?token=one&foo=two",
            ],
        )

    def test_verification_parser_deduplicates_and_does_not_open_links(self):
        link = "https://www.reddit.com/verification/abc?token=one"
        with patch("webbrowser.open", side_effect=AssertionError("must not open")):
            self.assertEqual(helper.parse_reddit_verification_links(f'<a href="{link}">{link}</a>'), [link])

    def test_command_parser_is_strict_and_supports_noninteractive_store(self):
        self.assertEqual(helper.parse_command_args(["gen", "4"]), {"command": "gen", "count": 4})
        self.assertEqual(
            helper.parse_command_args(["check", "--wait", "5", "--interval=2"]),
            {"command": "check", "wait_seconds": 5, "interval_seconds": 2, "show_links": False},
        )
        self.assertEqual(
            helper.parse_command_args(["gen", "1", "--store", "/tmp/accounts"]),
            {"command": "gen", "count": 1, "store": "/tmp/accounts"},
        )
        self.assertEqual(helper.parse_command_args(["check", "--show-links"]), {
            "command": "check", "wait_seconds": helper.DEFAULT_WAIT,
            "interval_seconds": helper.DEFAULT_INTERVAL, "show_links": True,
        })
        self.assertEqual(helper.parse_command_args(["--help"]), {"command": "help"})
        with self.assertRaises(helper.UsageError):
            helper.parse_command_args(["gen", "0"])
        with self.assertRaises(helper.UsageError):
            helper.parse_command_args(["check", "--wait=wat"])
        with self.assertRaises(helper.UsageError):
            helper.parse_command_args(["check", "--unknown"])
        with self.assertRaises(helper.UsageError):
            helper.parse_command_args(["check", "--wait", "1", "--wait", "2"])
        with self.assertRaises(helper.UsageError):
            helper.parse_command_args(["gen", "--store", "--unknown"])

    def test_new_inbox_rejects_malformed_or_control_character_email(self):
        for address in ("a@@b", "a@b/c", "a@\x00b"):
            transport = FakeTransport([
                {"sid_token": "sid", "email_addr": "initial@guerrillamailblock.com"},
                {"email_addr": address},
            ])
            with self.subTest(address=address), self.assertRaises(helper.ApiResponseError):
                helper.GuerrillaMailClient(transport=transport).new_inbox()

    def test_new_inbox_rotates_session_and_uses_no_network_in_fake(self):
        transport = FakeTransport([
            {"sid_token": "sid-one", "email_addr": "initial@guerrillamailblock.com"},
            {"sid_token": "sid-two", "email_addr": "rpcl.test@guerrillamailblock.com"},
        ])
        client = helper.GuerrillaMailClient(transport=transport)
        inbox = client.new_inbox()
        self.assertEqual(inbox.email, "rpcl.test@guerrillamailblock.com")
        self.assertEqual(inbox.session.sid_token, "sid-two")
        self.assertEqual([call[0]["f"] for call in transport.calls], ["get_email_address", "set_email_user"])
        self.assertEqual(transport.calls[1][0]["sid_token"], "sid-one")
        self.assertEqual(transport.calls[0][2], 15.0)
        self.assertIsNone(transport.calls[0][3])

    def test_check_inbox_filters_sender_and_deduplicates_links(self):
        link = "https://reddit.com/verify/token?x=1"
        transport = FakeTransport([
            {"list": [
                {"mail_id": "1", "mail_from": "Reddit <noreply@reddit.com>"},
                {"mail_id": "2", "mail_from": "noreply@reddit.com.evil.example"},
            ]},
            {"mail_body": f"{link} {link}"},
        ])
        account = helper.Account("user_abc", "Password1!", "u@example.test", helper.SessionState("sid"))
        links = helper.GuerrillaMailClient(transport=transport).check_inbox(account)
        self.assertEqual(links, [link])
        self.assertEqual(transport.calls[0][0]["sid_token"], "sid")
        self.assertEqual(transport.calls[1][0]["email_id"], "1")

    def test_malformed_message_metadata_is_reported(self):
        account = helper.Account("user_abc", "Password1!", "u@example.test", helper.SessionState("sid"))
        transport = FakeTransport([{"list": [{"mail_id": "1"}]}])
        with self.assertRaises(helper.ApiResponseError):
            helper.GuerrillaMailClient(transport=transport).check_inbox(account)

    def test_malformed_sender_and_message_body_are_rejected_without_consuming(self):
        transport = FakeTransport([
            {"list": [{"mail_id": "1", "mail_from": "not an address noreply@reddit.com"}]},
        ])
        account = helper.Account("user_abc", "Password1!", "u@example.test", helper.SessionState("sid"))
        self.assertEqual(helper.GuerrillaMailClient(transport=transport).check_inbox(account), [])
        self.assertEqual(account.seen_message_ids, ["1"])

        transport = FakeTransport([
            {"list": [{"mail_id": "2", "mail_from": "noreply@reddit.com"}]},
            {"mail_body": None},
        ])
        account = helper.Account("user_def", "Password1!", "u2@example.test", helper.SessionState("sid"))
        with self.assertRaises(helper.ApiResponseError):
            helper.GuerrillaMailClient(transport=transport).check_inbox(account)
        self.assertEqual(account.seen_message_ids, [])

    def test_response_cookies_are_validated_before_session_mutation(self):
        response = helper.HttpResponse(
            {"list": []},
            cookies=[{"name": "sid", "value": "safe; injected=1", "domain": helper.API_HOST, "path": "/", "secure": True}],
        )
        account = helper.Account("user_abc", "Password1!", "u@example.test", helper.SessionState("sid"))
        with self.assertRaises(helper.ApiResponseError):
            helper.GuerrillaMailClient(transport=FakeTransport([response])).check_inbox(account)
        self.assertEqual(account.session.cookies, [])

    def test_session_cookies_are_serialized_and_isolated(self):
        one = helper.SessionState("one", [{"name": "sid", "value": "a", "domain": "api.guerrillamail.com", "path": "/", "secure": True}])
        two = helper.SessionState("two")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            helper.save_accounts_atomic(path, [helper.Account("user_one", "Password1!", "one@example.test", one)])
            loaded = helper.load_accounts(path)
        self.assertEqual(loaded[0].session.sid_token, "one")
        self.assertEqual(loaded[0].session.cookies[0]["value"], "a")
        self.assertEqual(two.cookies, [])

    def test_verification_parser_rejects_ambiguous_authority_and_query_values(self):
        for url in (
            "https://@reddit.com/verify/token",
            "https://reddit.com:/verify/token",
            "https://reddit.com/verify/token#fragment",
            "https://reddit.com/verify/token?next=%2F%2Fevil.example",
            "https://reddit.com/verify/token?x=%250a",
        ):
            self.assertFalse(helper.is_allowed_verification_url(url), url)

    def test_verification_parser_rejects_path_traversal_and_encoded_separators(self):
        self.assertFalse(helper.is_allowed_verification_url("https://reddit.com/verify/../ordinary-page"))
        self.assertFalse(helper.is_allowed_verification_url("https://reddit.com/verify/%2e%2e/ordinary-page"))
        self.assertFalse(helper.is_allowed_verification_url("https://reddit.com/verification/token%2fother"))
        self.assertFalse(helper.is_allowed_verification_url("https://reddit.com/verify/token%5cother"))

    def test_atomic_save_is_private_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            helper.save_accounts_atomic(
                path,
                [helper.Account("user_one", "Password1!", "one@example.test", helper.SessionState("sid"))],
            )
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            path.chmod(0o644)
            with self.assertRaises(helper.AccountFileError):
                helper.load_accounts(path)
            helper.save_accounts_atomic(path, [])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            target = Path(directory) / "target"
            target.write_text("must remain")
            path.unlink()
            path.symlink_to(target)
            with self.assertRaises(helper.AccountFileError):
                helper.save_accounts_atomic(path, [])
            self.assertEqual(target.read_text(), "must remain")

    def test_atomic_write_failure_leaves_previous_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            old = [helper.Account("old_user", "Password1!", "old@example.test", helper.SessionState("old"))]
            new = [helper.Account("new_user", "Password1!", "new@example.test", helper.SessionState("new"))]
            helper.save_accounts_atomic(path, old)
            before = path.read_bytes()
            with patch.object(helper.os, "replace", side_effect=OSError("injected replace failure")):
                with self.assertRaises(helper.AccountFileError):
                    helper.save_accounts_atomic(path, new)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(helper.load_accounts(path)[0].username, "old_user")
            self.assertEqual(list(Path(directory).glob(".accounts.txt.*.tmp")), [])

    def test_versioned_record_with_null_session_is_not_treated_as_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            path.write_text(
                '{"schema_version":2,"username":"user_one","password":"Password1!",'
                '"email":"one@example.test","session":null,"sidToken":"legacy"}\n'
            )
            path.chmod(0o600)
            with self.assertRaises(helper.AccountFileError):
                helper.load_accounts(path)

    def test_legacy_json_lines_are_loaded_and_migrated_on_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            path.write_text(
                '# local\n{"username":"old_user","password":"Password1!",'
                '"email":"old@example.test","sidToken":"old-sid"}\n'
            )
            path.chmod(0o600)
            accounts = helper.load_accounts(path)
            self.assertEqual(accounts[0].session.sid_token, "old-sid")
            helper.save_accounts_atomic(path, accounts)
            record = json.loads(next(line for line in path.read_text().splitlines() if line.startswith("{")))
            self.assertEqual(record["schema_version"], 2)
            self.assertEqual(record["session"]["sid_token"], "old-sid")

    def test_positive_wait_stops_before_a_request_after_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            accounts = [
                helper.Account("user_one", "Password1!", "one@example.test", helper.SessionState("sid-one")),
                helper.Account("user_two", "Password1!", "two@example.test", helper.SessionState("sid-two")),
            ]
            helper.save_accounts_atomic(path, accounts)
            clock = FakeClock()
            clock.now = 10.0

            class AdvancingTransport(FakeTransport):
                def request(self, params, session, *, timeout, deadline=None):
                    result = super().request(params, session, timeout=timeout, deadline=deadline)
                    clock.now += 2.0
                    return result

            transport = AdvancingTransport([{"list": []}])
            out, err = StringIO(), StringIO()
            result = helper.main(
                ["check", "--wait", "1", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=transport, clock=clock.clock),
                stdout=out,
                stderr=err,
                clock=clock.clock,
                sleep=clock.sleep,
            )
        self.assertEqual(result, 1)
        self.assertEqual(len(transport.calls), 1)
        self.assertIn("polling stopped", err.getvalue())

    def test_wait_zero_checks_once_without_sleeping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            account = helper.Account("user_one", "Password1!", "one@example.test", helper.SessionState("sid"))
            helper.save_accounts_atomic(path, [account])
            transport = FakeTransport([{"list": []}])
            clock = FakeClock()
            out, err = StringIO(), StringIO()
            result = helper.main(
                ["check", "--wait", "0", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=transport),
                stdout=out,
                stderr=err,
                clock=clock.clock,
                sleep=clock.sleep,
            )
        self.assertEqual(result, 0)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(clock.sleeps, [])

    def test_check_reports_transport_failures_with_nonzero_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            account = helper.Account("user_one", "Password1!", "one@example.test", helper.SessionState("sid"))
            helper.save_accounts_atomic(path, [account])
            transport = FakeTransport([helper.TransportError("sid-token-secret")])
            result = helper.main(
                ["check", "--wait", "0", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=transport),
                stdout=StringIO(),
                stderr=StringIO(),
            )
        self.assertEqual(result, 1)

    def test_generation_is_manual_and_does_not_print_password_or_use_reddit(self):
        transport = FakeTransport([
            {"sid_token": "sid", "email_addr": "initial@guerrillamailblock.com"},
            {"email_addr": "rpcl.one@guerrillamailblock.com"},
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            out, err = StringIO(), StringIO()
            result = helper.main(
                ["gen", "1", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=transport),
                stdout=out,
                stderr=err,
            )
            self.assertEqual(result, 0)
            record = helper.load_accounts(path)[0]
        self.assertNotIn(record.password, out.getvalue())
        self.assertNotIn("reddit.com/api", out.getvalue())
        self.assertIn("sign up manually", out.getvalue())
        self.assertEqual(len(transport.calls), 2)

    def test_check_redacts_verification_tokens_by_default_and_reveals_explicitly(self):
        link = "https://reddit.com/verify/token?token=bearer-secret"
        account = helper.Account("user_abc", "Password1!", "u@example.test", helper.SessionState("sid"))
        transport = FakeTransport([
            {"list": [{"mail_id": "1", "mail_from": "noreply@reddit.com"}]},
            {"mail_body": link},
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            helper.save_accounts_atomic(path, [account])
            out = StringIO()
            self.assertEqual(helper.main(
                ["check", "--wait", "0", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=transport),
                stdout=out,
                stderr=StringIO(),
            ), 0)
            self.assertNotIn("bearer-secret", out.getvalue())

            reveal_transport = FakeTransport([
                {"list": [{"mail_id": "2", "mail_from": "noreply@reddit.com"}]},
                {"mail_body": link},
            ])
            reveal_out = StringIO()
            self.assertEqual(helper.main(
                ["check", "--wait", "0", "--show-links", "--store", str(path)],
                client=helper.GuerrillaMailClient(transport=reveal_transport),
                stdout=reveal_out,
                stderr=StringIO(),
            ), 0)
            self.assertIn("bearer-secret", reveal_out.getvalue())

    def test_main_help_is_successful_and_does_not_construct_a_client(self):
        out = StringIO()
        self.assertEqual(helper.main(["--help"], stdout=out, stderr=StringIO()), 0)
        self.assertIn("human-guided Reddit signup", out.getvalue())


if __name__ == "__main__":
    unittest.main()
