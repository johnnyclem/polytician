import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("audience-source.py")
TEMPLATES = ["namespace/<namespace>"]
READERS = {
    "version": 1,
    "namespaces": {
        "default": ["alice@corp.example", "bob@corp.example", "alice@corp.example"],
        "ops:oncall": ["carol@corp.example", "polytician:pager-bot"],
    },
}


def consult(artifact, readers_path, templates=TEMPLATES, name="polytician", kind="audience"):
    request = {
        "version": 1,
        "kind": kind,
        "name": name,
        "declaration": {"templates": templates},
        "artifact": artifact,
    }
    env = {key: value for key, value in os.environ.items() if key != "POLYTICIAN_NAMESPACE_READERS"}
    if readers_path is not None:
        env["POLYTICIAN_NAMESPACE_READERS"] = str(readers_path)
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


class AudienceSourceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.readers = Path(self.dir.name) / "readers.json"
        self.write(READERS)

    def tearDown(self):
        self.dir.cleanup()

    def write(self, document):
        self.readers.write_text(json.dumps(document), encoding="utf-8")

    def answer(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(sorted(response), ["answer", "version"])
        self.assertEqual(response["version"], 1)
        return response["answer"]

    def test_answers_a_namespace_with_its_readers_once_each(self):
        answer = self.answer(consult({"selector": "namespace/default"}, self.readers))
        self.assertEqual(answer, {"members": ["alice@corp.example", "bob@corp.example"]})

    def test_accepts_every_character_polytician_allows_in_a_namespace(self):
        answer = self.answer(consult({"selector": "namespace/ops:oncall"}, self.readers))
        self.assertEqual(answer, {"members": ["carol@corp.example", "polytician:pager-bot"]})

    def test_refuses_a_namespace_the_file_does_not_list(self):
        result = consult({"selector": "namespace/finance"}, self.readers)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("finance", result.stderr)

    def test_refuses_selectors_it_does_not_serve(self):
        for selector in ["namespace", "namespace/", "namespace/a/b", "viewer", "namespace/-x", 7]:
            with self.subTest(selector=selector):
                self.assertEqual(consult({"selector": selector}, self.readers).returncode, 1)

    def test_answers_a_polytician_member_lookup_with_null(self):
        answer = self.answer(consult({"member": "polytician:pager-bot"}, self.readers))
        self.assertEqual(answer, {"principal": None})
        self.assertEqual(consult({"member": "slack:U1"}, self.readers).returncode, 1)

    def test_refuses_mismatched_templates_before_reading_the_file(self):
        result = consult({"selector": "namespace/default"}, None, templates=["namespace/<ns>", "viewer"])
        self.assertEqual(result.returncode, 2)
        self.assertIn("declares", result.stderr)

    def test_refuses_without_a_readers_file(self):
        self.assertEqual(consult({"selector": "namespace/default"}, None).returncode, 1)
        self.assertEqual(consult({"selector": "namespace/default"}, "readers.json").returncode, 1)
        self.assertEqual(
            consult({"selector": "namespace/default"}, Path(self.dir.name) / "missing.json").returncode, 1
        )

    def test_refuses_a_malformed_readers_file(self):
        for document in [
            [],
            {"version": 2, "namespaces": {}},
            {"version": 1},
            {"version": 1, "namespaces": {"bad namespace": ["a@corp.example"]}},
            {"version": 1, "namespaces": {"default": "a@corp.example"}},
            {"version": 1, "namespaces": {"default": ["finance"]}},
            {"version": 1, "namespaces": {"default": ["github:alice"]}},
            {"version": 1, "namespaces": {"default": ["polytician:"]}},
        ]:
            with self.subTest(document=document):
                self.write(document)
                self.assertEqual(consult({"selector": "namespace/default"}, self.readers).returncode, 1)

    def test_refuses_other_consults(self):
        self.assertEqual(consult({"selector": "namespace/default"}, self.readers, kind="authority").returncode, 1)
        self.assertEqual(consult({"selector": "namespace/default"}, self.readers, name="slack").returncode, 1)
        self.assertEqual(consult({"selector": "namespace/default", "member": "x"}, self.readers).returncode, 1)


if __name__ == "__main__":
    unittest.main()
