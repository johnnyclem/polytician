"""The polytician audience source: one consult in, one answer out.

Serves one selector template:

  namespace/<namespace>   the readers of one Polytician namespace

Polytician keeps no per-namespace permissions, so the operator writes them
down: POLYTICIAN_NAMESPACE_READERS names a JSON file (an absolute path)

  {"version": 1, "namespaces": {"default": ["alice@corp.example"], ...}}

mapping each namespace to its readers, as email addresses or
`polytician:<id>` reader IDs. A namespace the file does not list, a missing
or malformed file, and any other failure exit nonzero: the runtime treats
that as no answer and refuses the operation, so an unlisted namespace is
never readable or writable by default.

A member lookup for a `polytician:<id>` reader answers null: the reader
stays as written.
"""

import json
import os
import re
import sys


READERS_VAR = "POLYTICIAN_NAMESPACE_READERS"
SOURCE_NAME = "polytician"
SERVED_TEMPLATES = ["namespace/<namespace>"]
# Polytician's own namespace rule (src/types/limits.ts NAMESPACE_PATTERN).
NAMESPACE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
MAX_MEMBERS = 5000


def is_reader(member):
    if not isinstance(member, str):
        return False
    if member.startswith(f"{SOURCE_NAME}:"):
        return len(member) > len(SOURCE_NAME) + 1
    return EMAIL.fullmatch(member) is not None


def load_readers(path):
    if not path:
        raise RuntimeError(f"{READERS_VAR} is not set")
    if not os.path.isabs(path):
        raise RuntimeError(f"{READERS_VAR} must be an absolute path")
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    if not isinstance(document, dict) or document.get("version") != 1:
        raise RuntimeError("the readers file must be an object with version 1")
    namespaces = document.get("namespaces")
    if not isinstance(namespaces, dict):
        raise RuntimeError("the readers file carries no namespaces object")
    for namespace, readers in namespaces.items():
        if NAMESPACE.fullmatch(namespace) is None:
            raise RuntimeError(f"{namespace!r} is not a Polytician namespace")
        if not isinstance(readers, list) or not all(is_reader(reader) for reader in readers):
            raise RuntimeError(f"the readers of {namespace!r} must be email addresses or polytician:<id>")
        if len(readers) > MAX_MEMBERS:
            raise RuntimeError(f"{namespace!r} has more than {MAX_MEMBERS} readers")
    return namespaces


def members(namespaces, selector):
    match selector.split("/") if isinstance(selector, str) else None:
        case ["namespace", name] if NAMESPACE.fullmatch(name):
            pass
        case _:
            raise ValueError(f"{selector!r} names no collection this source serves")
    if name not in namespaces:
        raise RuntimeError(f"namespace {name!r} has no readers in the readers file")
    return list(dict.fromkeys(namespaces[name]))


def member_principal(member):
    if not is_reader(member) or not member.startswith(f"{SOURCE_NAME}:"):
        raise ValueError(f"{member!r} is not a polytician-qualified member")
    return None


def answer(read_namespaces, artifact):
    if not isinstance(artifact, dict):
        raise ValueError("the artifact must be an object")
    match sorted(artifact):
        case ["selector"]:
            return {"members": members(read_namespaces(), artifact["selector"])}
        case ["member"]:
            return {"principal": member_principal(artifact["member"])}
        case _:
            raise ValueError("the artifact must carry exactly a selector or a member")


def check_declaration(request):
    """The policy's declared templates against the ones this script serves.

    A mismatch is a version skew between policy and script, refused before
    the readers file is read; the exit status 2 tells it apart from a
    configuration failure.
    """
    declared = request.get("declaration", {}).get("templates")
    if declared != SERVED_TEMPLATES:
        print(
            f"{SOURCE_NAME} audience source: the policy declares {declared!r}, this script serves {SERVED_TEMPLATES!r}",
            file=sys.stderr,
        )
        raise SystemExit(2)


def main():
    request = json.load(sys.stdin)

    if request.get("version") != 1:
        raise ValueError("unsupported request version")
    if request.get("kind") != "audience":
        raise ValueError("unexpected consult kind")
    if request.get("name") != SOURCE_NAME:
        raise ValueError("unexpected source name")
    check_declaration(request)

    def read_namespaces():
        return load_readers(os.environ.get(READERS_VAR))

    json.dump({"version": 1, "answer": answer(read_namespaces, request.get("artifact"))}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        print(f"polytician audience source: {error}", file=sys.stderr)
        raise SystemExit(1)
