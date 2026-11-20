"""Which App XCTest identifiers a diff affects: the TalariaKit package tests and the simulator-hosted TalariaTests (TAL-2390).

scripts/changed-components.py owns the diff and calls `plan()`. Each lane comes out as `full` (the whole target), `explicit`
(sorted target-qualified identifiers, `Target/Class` or `Target/Class/testMethod`) or `empty`, with the reasons that chose
it. Narrowing is structural for test code and reviewed for production code:

- A changed line inside one test method selects that method in its class and every subclass. A change anywhere else in a
  test class (setUp, helpers, stored properties, its header) selects the whole class and its subclasses. A change in test
  support selects every test that reaches the changed declaration by name, transitively through other declarations. A
  declaration that runs without its name being written (init, body, overrides, members of a type with conformances)
  reaches every user of its type as well. Comment and whitespace lines change nothing.
- Production code narrows only through a rule in app/ci/test-ownership.json: its files, every first-order consumer a
  reviewer checked, and the tests that cover them. A rule whose files gained an unlisted reference or a foreign extension,
  or whose tests are gone, is stale and widens.
- A test method whose own lines changed, added included, is also listed in its lane's `repeat`: pull request CI runs it
  repeatedly within a time budget to catch a flaky test before it merges (TAL-2402).
- Anything else, and anything the scanner cannot read, runs the affected target in full: the hosted target for the App,
  its extensions, resources and project; both targets for TalariaKit sources, the package manifest and shared CI.

Identifiers come from the tested tree, so a deleted or renamed test never runs under its old name.
"""

from dataclasses import dataclass, field
import difflib
import json
import os
import re
import subprocess

PACKAGE, HOSTED = "TalariaKitTests", "TalariaTests"
TARGETS = (PACKAGE, HOSTED)
PACKAGE_DIR = "app/TalariaKit/Tests/TalariaKitTests/"
HOSTED_DIR = "app/TalariaTests/"
PROJECT = "app/Talaria.xcodeproj/project.pbxproj"
OWNERSHIP = "app/ci/test-ownership.json"
PRODUCTION_DIRS = ("app/Talaria/", "app/TalariaKit/Sources/", "app/TalariaLiveActivityWidget/", "app/TalariaShareExtension/")
# The live Web contract proof (app-package-tests): the current fixture's decoding test, and SharedContractTests beside it
# for each retained Web release. A selected contracts suite runs them whatever else the package lane holds.
CONTRACT_PROOF = (f"{PACKAGE}/APIClientSessionListTests/testLiveUpstreamContractResponsesDecodeWhenSupplied",
                  f"{PACKAGE}/SharedContractTests")
# Members that run without their name at the call site; a change to one reaches every user of its type instead.
IMPLICIT = {"init", "deinit", "subscript", "body", "callAsFunction", "description", "debugDescription", "hash", "encode",
            "setUp", "tearDown", "setUpWithError", "tearDownWithError", "invokeTest", "makeUIView", "updateUIView",
            "makeUIViewController", "updateUIViewController", "makeCoordinator", "layoutSubviews", "draw"}
DECL = re.compile(r"\b(class|struct|enum|actor|protocol|extension|func|init|deinit|subscript|var|let)\b")
TYPES = {"class", "struct", "enum", "actor", "protocol", "extension"}
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
TOP_LEVEL_VALUE = re.compile(r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:\w+\s+)*?(?:let|var|func|typealias)\s+([A-Za-z_]\w*)")


class Uncertain(Exception):
    """The scanner or the ownership data cannot bound a change; its target runs in full."""


# ---------------------------------------------------------------------------------------------------------------- Swift

def clean(text, strings=False):
    """Blank comments. String contents become `s`, so their braces and quotes never count while a line of a multi-line
    string still counts as code; `strings` keeps them verbatim instead, for comparing two revisions' code."""
    out, i, n = [], 0, len(text)
    stack = []  # Open string literals: [hashes, multiline, interpolation paren depth or None].
    while i < n:
        c = text[i]
        if stack and stack[-1][2] is None:  # Inside a string literal.
            hashes, multi, _ = stack[-1]
            close = ('"""' if multi else '"') + "#" * hashes
            if text.startswith(close, i):
                out.append(close)
                i += len(close)
                stack.pop()
            elif c == "\\" and text.startswith("#" * hashes + "(", i + 1):
                out.append("\\" + "#" * hashes + "(")
                i += 2 + hashes
                stack[-1][2] = 0
            elif c == "\\" and text.startswith("#" * hashes, i + 1) and i + 1 + hashes < n:
                escaped = text[i + 1 + hashes]
                out.append(text[i:i + 2 + hashes] if strings else "s" * (1 + hashes) + ("\n" if escaped == "\n" else "s"))
                i += 2 + hashes
            elif c == "\n" and not multi:
                raise Uncertain("unterminated string literal")
            else:
                out.append(c if strings or c == "\n" else "s")
                i += 1
            continue
        if stack and c in "()":  # Code inside a string interpolation.
            if c == ")" and stack[-1][2] == 0:
                stack[-1][2] = None
            else:
                stack[-1][2] += 1 if c == "(" else -1
            out.append(c)
            i += 1
            continue
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            out.append(" " * (end - i))
            i = end
            continue
        if text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            if depth:
                raise Uncertain("unterminated comment")
            out.append("".join("\n" if ch == "\n" else " " for ch in text[i:j]))
            i = j
            continue
        literal = re.match(r'(#*)("""|")', text[i:i + 12]) if c in '#"' else None
        if literal:
            out.append(literal.group(0))
            i += len(literal.group(0))
            stack.append([len(literal.group(1)), literal.group(2) == '"""', None])
            continue
        out.append(c)
        i += 1
    if stack:
        raise Uncertain("unterminated string literal")
    return "".join(out)


@dataclass(eq=False)
class Decl:
    kind: str
    name: str
    start: int  # First line, 1-based, including attribute lines above it.
    end: int  # Its closing brace's line.
    prefix: str  # Modifiers and attributes before the keyword.
    header: str  # From the keyword to the opening brace.
    parent: "Decl | None" = None
    inherits: list = field(default_factory=list)
    tokens: set = field(default_factory=set)  # Every identifier in the declaration.
    own: set = field(default_factory=set)  # A type's identifiers outside its member declarations.
    children: list = field(default_factory=list)
    path: str = ""

    @property
    def is_type(self):
        return self.kind in TYPES

    @property
    def modifiers(self):
        return set(IDENT.findall(self.prefix))

    @property
    def refs(self):
        """What this declaration references, leaving out its own name."""
        return (self.own if self.is_type else self.tokens) - {self.name}


def scan(text, path=""):
    """Top-level declarations with braces and, inside each type body, its member declarations; and the cleaned lines."""
    code = clean(text)
    lines = code.split("\n")
    starts = [0]
    for index, ch in enumerate(code):
        if ch == "\n":
            starts.append(index + 1)

    def line_of(offset):
        low, high = 0, len(starts) - 1
        while low < high:
            middle = (low + high + 1) // 2
            low, high = (middle, high) if starts[middle] <= offset else (low, middle - 1)
        return low + 1

    pairs, stack = {}, []
    for index, ch in enumerate(code):
        if ch == "{":
            stack.append(index)
        elif ch == "}":
            if not stack:
                raise Uncertain(f"unbalanced brace on line {line_of(index)}")
            pairs[stack.pop()] = index
    if stack:
        raise Uncertain("unbalanced braces")

    def declare(low, high, parent):
        found, previous = [], low
        opened = code.find("{", low, high)
        while opened >= 0:
            closed, header_start = pairs[opened], previous
            previous = closed + 1
            header = code[header_start:opened]
            matches = [m for m in DECL.finditer(header)
                       if not (m.group(1) in ("class", "static") and re.match(r"\s*(func|var|let|init|subscript)\b", header[m.end():]))]
            decl = None
            if matches:
                keyword = matches[-1]
                kind, rest = keyword.group(1), header[keyword.end():]
                named = None if kind in ("init", "deinit", "subscript") else re.match(r"\s*([A-Za-z_][\w.]*|[^\s(<{:]+)", rest)
                name = kind if kind in ("init", "deinit", "subscript") else (named.group(1) if named else None)
                if name:
                    at = header_start + keyword.start()
                    first = line_of(at)
                    for number in range(first - 1, 0, -1):  # Attribute lines above the keyword belong to it.
                        stripped = lines[number - 1].strip()
                        if stripped.startswith("@"):
                            first = number
                        elif stripped:
                            break
                    inherits = []
                    if kind in TYPES:
                        clause = re.match(r"\s*[\w.]+(?:<[^{]*?>)?\s*:\s*(.*?)(?:\bwhere\b.*)?$", rest, re.S)
                        if clause:
                            inherits = [part.strip().split("<")[0] for part in clause.group(1).split(",") if part.strip()]
                    decl = Decl(kind, name, first, line_of(closed), code[starts[first - 1]:at], rest, parent, inherits,
                                set(IDENT.findall(code[at:closed + 1])), path=path)
                    if kind in TYPES:
                        decl.children = declare(opened + 1, closed, decl)
                        own, cursor = [], at
                        for child in decl.children:
                            child_at = starts[child.start - 1]
                            own.append(code[cursor:child_at])
                            cursor = starts[child.end] if child.end < len(starts) else closed
                        own.append(code[cursor:closed + 1])
                        decl.own = set(IDENT.findall("".join(own)))
                    found.append(decl)
            opened = code.find("{", previous, high)
        return found

    return declare(0, len(code), None), lines


# ----------------------------------------------------------------------------------------------------------- Universe

def walk(decls):
    for decl in decls:
        yield decl
        yield from walk(decl.children)


PRIVATE = {"private", "fileprivate"}


def is_test_method(decl):
    return (decl.kind == "func" and decl.name.startswith("test") and not ({"static", "class", "private"} & decl.modifiers)
            and re.match(rf"\s*{re.escape(decl.name)}\s*\(\s*\)", decl.header) is not None)


def plain(decl):
    """Whether callers write this declaration's name."""
    return decl.kind not in ("init", "deinit", "subscript") and decl.name not in IMPLICIT and IDENT.fullmatch(decl.name) is not None


def implicit(decl):
    """Whether it can run without its name at the call site."""
    parent = decl.parent
    return not plain(decl) or "override" in decl.modifiers or (parent is not None and bool(parent.inherits))


def locate(decls, number):
    """The chain of declarations containing a line, outermost first."""
    for decl in decls:
        if decl.start <= number <= decl.end:
            return [decl, *locate(decl.children, number)]
    return []


class Universe:
    """One test target's declarations at the tested revision."""

    def __init__(self, target, sources):
        self.target = target
        self.files, self.lines = {}, {}
        for path, text in sorted(sources.items()):
            self.files[path], self.lines[path] = scan(text, path)
        self.units = [decl for decls in self.files.values() for decl in walk(decls)]
        self.trail = set()
        self.scanned = {}  # Name set -> (tests, trail it added): see reached().
        self.written = set()  # The test methods whose own lines changed: what a pull request repeats (TAL-2402).
        self.declared = {decl.name for decl in self.units if decl.parent is None}  # What the tested revision still has.
        self.superclass = {}
        for decl in self.units:
            if decl.kind == "class" and decl.inherits:
                self.superclass.setdefault(decl.name, decl.inherits[0])
        self.test_classes = {decl.name for decl in self.units if decl.kind == "class" and self.descends(decl.name)}
        self.methods = {}  # Test class -> the test methods declared in its body and extensions.
        for decl in self.units:
            if decl.parent is None and decl.name in self.test_classes:
                self.methods.setdefault(decl.name, set()).update(child.name for child in decl.children if is_test_method(child))

    def descends(self, name):
        seen = set()
        while name in self.superclass and name not in seen:
            seen.add(name)
            name = self.superclass[name]
            if name == "XCTestCase":
                return True
        return False

    def lineage(self, name):
        """The class and every test class below it."""
        found, changed = {name}, True
        while changed:
            changed = False
            for child, parent in self.superclass.items():
                if parent in found and child not in found and child in self.test_classes:
                    found.add(child)
                    changed = True
        return found

    def all_methods(self, name):
        names, seen = set(), set()
        while name in self.test_classes and name not in seen:
            seen.add(name)
            names |= self.methods.get(name, set())
            name = self.superclass.get(name)
        return names

    def whole(self, names):
        """Identifiers for whole classes, leaving out base classes without a test of their own or inherited."""
        return {f"{self.target}/{cls}" for name in names if name in self.test_classes
                for cls in self.lineage(name) if self.all_methods(cls)}

    def method(self, cls, name):
        return {f"{self.target}/{each}/{name}" for each in self.lineage(cls) if name in self.all_methods(each)}

    def test_class_of(self, decl):
        while decl.parent is not None:
            decl = decl.parent
        return decl.name if decl.is_type and decl.name in self.test_classes else None

    def is_test(self, decl):
        """A test method directly in a test class's body or extension."""
        return is_test_method(decl) and decl.parent is not None and decl.parent.parent is None and \
            decl.parent.name in self.test_classes

    def reach(self, names):
        """Every test that reaches any of `names`, transitively through other declarations; `trail` collects the
        declarations it went through, to explain a broad selection."""
        seeds = set(names)
        names, result, pending = set(names), set(), True
        while pending:
            pending = False
            for unit in self.units:
                if self.is_test(unit) or not (unit.refs & names):
                    continue
                cls = self.test_class_of(unit)
                reached = ({unit.name} if plain(unit) else set()) | ({(unit.parent or unit).name} if implicit(unit) else set())
                if cls and unit.parent is not None:
                    reached = ({unit.name} if plain(unit) and not implicit(unit) else set()) | {cls}
                if not reached <= names:
                    names |= reached
                    pending = True
        for unit in self.units:
            if self.is_test(unit) and unit.refs & names:
                result |= self.method(unit.parent.name, unit.name)
        self.trail |= names - seeds
        return result | self.whole(names & self.test_classes)

    def reached(self, names):
        """`reach`, scanned once per distinct name set: every changed line of one declaration seeds the same names, and
        a diff of hundreds of lines repeated the whole-universe fixpoint for each (TAL-2473). A repeat replays the trail
        the scan added, since the caller resets `trail` for each file it explains."""
        key = frozenset(names)
        if key not in self.scanned:
            trail, self.trail = self.trail, set()
            self.scanned[key] = (self.reach(key), self.trail)
            self.trail = trail
        found, added = self.scanned[key]
        self.trail |= added
        return found

    def private_reach(self, decls, chain):
        """The tests a changed private or fileprivate declaration reaches. Only its own file can name it, so follow the
        file's references to it until they leave through a declaration other files can name: matched by bare name
        across the target, a private member called `type` or `line` reached every test (TAL-2610)."""
        units, stack = [], list(decls)
        while stack:
            unit = stack.pop()
            units.append(unit)
            stack.extend(unit.children)

        def hidden(unit):
            while unit is not None:
                if PRIVATE & unit.modifiers:
                    return True
                unit = unit.parent
            return False

        names, exits, pending = {decl.name for decl in chain}, set(), True
        while pending:
            pending = False
            for unit in units:
                if unit.name in names or not unit.refs & names:
                    continue
                if hidden(unit):
                    names.add(unit.name)
                    pending = True
                else:
                    exits.add(unit)
        result = set()
        for unit in exits:
            cls = self.test_class_of(unit)
            if cls and self.is_test(unit):
                result |= self.method(cls, unit.name)
            elif cls:
                result |= self.whole({cls})
            else:
                result |= self.reached({unit.name})
        return result

    def changed(self, decls, lines, numbers):
        """The tests a file's changed lines reach, resolved by name in this universe: a test deleted or renamed since
        that side resolves to nothing, and its new name, if any, is on the other side of the diff."""
        result = set()
        for number in sorted(numbers):
            chain = locate(decls, number)
            if not chain:
                value = TOP_LEVEL_VALUE.match(lines[number - 1])
                for above in range(number - 1, 0, -1):
                    if value or locate(decls, above):
                        break
                    value = TOP_LEVEL_VALUE.match(lines[above - 1])
                if value and not lines[number - 1].lstrip().startswith("import "):
                    result |= self.reached({value.group(1)})
                else:  # An import or an unreadable top-level statement: everything the file declares.
                    result |= self.reached({decl.name for decl in decls}) | self.whole({decl.name for decl in decls})
                continue
            top, deepest = chain[0], chain[-1]
            if any(PRIVATE & decl.modifiers for decl in chain):
                result |= self.private_reach(decls, chain)
                continue
            cls = top.name if top.is_type and top.name in self.test_classes else None
            if cls is None and top.kind in ("class", "extension") and top.name.endswith(("Tests", "TestCase")) and \
                    top.name in self.superclass:  # Present at the tested revision, under a base this target lacks.
                raise Uncertain(f"cannot tell whether {top.name} is a test class: its superclass is outside {self.target}")
            if cls and len(chain) == 2 and is_test_method(deepest):
                if lines[number - 1].strip() != "}":  # The diff can pair a neighbour's closing brace with an added method's.
                    self.written |= self.method(cls, deepest.name)
                result |= self.method(cls, deepest.name) | self.reached({deepest.name})
            elif cls:
                member = chain[1] if len(chain) > 1 else None
                names = {cls} if member is None or implicit(member) else {cls, member.name}
                result |= self.whole({cls}) | self.reached(names)
            else:
                owner = deepest if deepest.is_type else (deepest.parent or deepest)
                if any(name.startswith("XCTest") and name != "XCTestCase" for name in owner.inherits):  # XCTestObservation
                    raise Uncertain(f"{owner.name} conforms to {', '.join(owner.inherits)}: XCTest invokes it for every test")
                names = ({deepest.name} if plain(deepest) else set()) | \
                    ({owner.name} if implicit(deepest) or deepest.is_type else set())
                found = self.reached(names)
                if not found and (implicit(deepest) or deepest.is_type) and owner.name in self.declared:
                    raise Uncertain(f"no test names {owner.name}, so the runtime may invoke {deepest.name}")
                result |= found
        return result


# ---------------------------------------------------------------------------------------------------------------- Trees

def git(*args, data=None):
    return subprocess.run(["git", *args], input=data, check=True, capture_output=True).stdout


class Tree:
    """A revision's files under root (app/ by default), or the working tree's (tracked and untracked, not ignored)."""

    def __init__(self, revision=None, root="app"):
        self.revision = revision
        if revision:
            listing = git("ls-tree", "-r", "-z", "--name-only", revision, "--", root).split(b"\0")
        else:
            listing = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", root).split(b"\0")
        self.paths = sorted({path for path in (os.fsdecode(item) for item in listing if item) if revision or os.path.isfile(path)})
        self.cache = {}

    def read(self, paths):
        missing = [path for path in paths if path not in self.cache]
        if missing and self.revision:
            data = git("cat-file", "--batch", data="".join(f"{self.revision}:{path}\n" for path in missing).encode())
            index = 0
            for path in missing:
                header_end = data.index(b"\n", index)
                header = data[index:header_end].split()
                if header[-1] == b"missing":
                    self.cache[path], index = None, header_end + 1
                    continue
                size = int(header[2])
                self.cache[path] = data[header_end + 1:header_end + 1 + size].decode(errors="replace")
                index = header_end + 2 + size
        elif missing:
            for path in missing:
                try:
                    with open(path, encoding="utf-8", errors="replace") as handle:
                        self.cache[path] = handle.read()
                except (FileNotFoundError, IsADirectoryError):
                    self.cache[path] = None
        return {path: self.cache[path] for path in paths}

    def swift(self, prefixes):
        return [path for path in self.paths if path.endswith(".swift") and path.startswith(prefixes)]


def hosted_sources(project):
    """Repository paths of the TalariaTests target's compiled sources, from the project file."""
    objects = {match.group(1): match.group(2) for match in re.finditer(
        r"^\t\t([0-9A-Za-z]+)(?: /\*[^\n]*?\*/)? = (\{[^\n]*\}|\{\n.*?\n\t\t\});$", project, re.M | re.S)}
    if not objects:
        raise Uncertain("the project file lists no objects")

    def value(body, key):
        found = re.search(rf"(?<![\w.]){key} = (\"(?:[^\"\\\\]|\\\\.)*\"|[^;]+);", body)
        return found.group(1).strip('"').split(" /*")[0] if found else None

    def listed(body, key):
        block = body.split(f"{key} = (", 1)
        entries = [line.strip() for line in block[1].split(");", 1)[0].split("\n") if line.strip()] if len(block) == 2 else []
        keys = [re.match(r"([0-9A-Za-z]+)(?: /\*.*\*/)?,$", entry) for entry in entries]
        if not all(keys):
            raise Uncertain(f"unreadable {key} entry in the project file")
        return [match.group(1) for match in keys]

    targets = [body for body in objects.values() if "isa = PBXNativeTarget" in body and value(body, "name") == HOSTED]
    phases = [key for key in listed(targets[0], "buildPhases") if "isa = PBXSourcesBuildPhase" in objects.get(key, "")] \
        if len(targets) == 1 else []
    if len(phases) != 1:
        raise Uncertain("the project has no single TalariaTests Sources phase")
    parents = {child: key for key, body in objects.items() if "isa = PBXGroup" in body for child in listed(body, "children")}
    paths = set()
    for build in listed(objects[phases[0]], "files"):
        key, parts = value(objects.get(build, ""), "fileRef"), []
        if key not in objects:
            raise Uncertain(f"build file {build} has no file reference")
        while key is not None:
            body = objects.get(key, "")
            tree = value(body, "sourceTree")
            if value(body, "path"):
                parts.append(value(body, "path"))
            if tree == "SOURCE_ROOT" or key not in parents:
                break
            if tree != "<group>":
                raise Uncertain(f"unsupported source tree {tree}")
            key = parents[key]
        paths.add(os.path.normpath(os.path.join("app", *reversed(parts))))
    return paths


# ----------------------------------------------------------------------------------------------------------------- Diff

def code_changes(before, after):
    """(old line numbers, new line numbers) whose code differs: comments and whitespace outside string literals never
    count; whitespace inside a string literal does."""
    def keys(text):
        if text is None:
            return []
        result = []
        # Both cleanings keep every line's length: one marks string contents as `s`, the other keeps them verbatim, so
        # the first shows how much of each end is code whitespace or a comment.
        for marked, verbatim in zip(clean(text).split("\n"), clean(text, strings=True).split("\n")):
            result.append(verbatim[len(marked) - len(marked.lstrip()):len(marked.rstrip())])
        return result

    old, new = keys(before), keys(after)
    changed_old, changed_new = set(), set()
    for tag, low_old, high_old, low_new, high_new in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag != "equal":
            changed_old |= {number + 1 for number in range(low_old, high_old) if old[number]}
            changed_new |= {number + 1 for number in range(low_new, high_new) if new[number]}
    return changed_old, changed_new


# ----------------------------------------------------------------------------------------------------------------- Plan

class Lane:
    def __init__(self, target):
        self.target, self.full, self.identifiers, self.reasons = target, False, set(), []
        self.written = set()

    def widen(self, reason):
        self.full = True
        self.reasons.append(reason)

    def add(self, identifiers, reason):
        self.identifiers |= identifiers
        self.reasons.append(reason)

    def result(self):
        # `repeat`: the test methods the diff adds or changes, whatever the lane's mode; CI repeats them (TAL-2402).
        repeat = sorted(self.written)
        if self.full:
            return {"mode": "full", "identifiers": [self.target], "reasons": self.reasons, "repeat": repeat}
        identifiers = collapse(self.identifiers)
        return {"mode": "explicit" if identifiers else "empty", "identifiers": identifiers,
                "reasons": self.reasons or ["No changed path reaches this target."], "repeat": repeat}


def collapse(identifiers):
    """Sorted identifiers, without the methods of a class that is selected whole."""
    classes = {identifier for identifier in identifiers if identifier.count("/") == 1}
    return sorted(identifier for identifier in identifiers if identifier.count("/") == 1 or identifier.rsplit("/", 1)[0] not in classes)


def widened(path):
    """The targets an unbounded change can reach."""
    if path.startswith(("app/Talaria/", "app/TalariaLiveActivityWidget/", "app/TalariaShareExtension/",
                        "app/Talaria.xcodeproj/", "app/Config/", HOSTED_DIR)):
        return (HOSTED,)  # TalariaKit's package tests never compile the App, its extensions or its project.
    return TARGETS


class Planner:
    def __init__(self, base, head, tree):
        self.base, self.head, self.tree = base, head, tree
        self.lanes = {target: Lane(target) for target in TARGETS}
        text = tree.read([OWNERSHIP])[OWNERSHIP]
        self.ownership = json.loads(text) if text else None
        if self.ownership is not None and self.ownership.get("version") != 1:
            self.ownership = None
        self.rules = {path: rule for rule in (self.ownership or {}).get("rules", []) for path in rule["paths"]}
        self.problems = {}
        self.universes = {}
        project = tree.read([PROJECT])[PROJECT]
        try:
            self.hosted_members = hosted_sources(project or "")
        except Uncertain as error:
            self.hosted_members = error
        self.members = {PACKAGE: tree.swift((PACKAGE_DIR,))}
        if not isinstance(self.hosted_members, Uncertain):
            self.members[HOSTED] = sorted(path for path in self.hosted_members if path in tree.paths)

    def universe(self, target):
        if target not in self.universes:
            try:
                if isinstance(self.hosted_members, Uncertain) and target == HOSTED:
                    raise self.hosted_members
                texts = self.tree.read(self.members[target])
                if any("import Testing" in text for text in texts.values() if text):
                    raise Uncertain("it uses Swift Testing, which this planner does not read")
                self.universes[target] = Universe(target, {path: text for path, text in texts.items() if text is not None})
            except Uncertain as error:
                self.universes[target] = Uncertain(f"cannot read {target}: {error}")
        return self.universes[target]

    def targets_of(self, path):
        found = [PACKAGE] if path.startswith(PACKAGE_DIR) else []
        hosted = self.hosted_members
        if isinstance(hosted, Uncertain) or path in hosted or path.startswith(HOSTED_DIR):
            found.append(HOSTED)
        return found

    def rule_problem(self, rule, deleted):
        if rule["name"] not in self.problems:
            self.problems[rule["name"]] = self.check_rule(rule, deleted)
        return self.problems[rule["name"]]

    def check_rule(self, rule, deleted):
        """Why a production rule cannot narrow at the tested tree, or None."""
        paths = set(rule["paths"])
        texts = self.tree.read(sorted(paths))
        if paths & deleted or any(text is None for text in texts.values()):
            return "one of its files is deleted or missing"
        declared = [decl for path, text in texts.items() for decl in scan(text, path)[0]]
        own = {decl.name for decl in declared if decl.kind != "extension"}
        names = {decl.name for decl in declared if decl.kind != "extension" and not {"private", "fileprivate"} & decl.modifiers}
        for decl in declared:
            if decl.kind == "extension" and decl.name not in own and not {"private", "fileprivate"} & decl.modifiers:
                return f"{decl.path} extends {decl.name}, so callers reach it without naming the rule's types"
        listed = {}
        for identifier in rule["tests"]:
            target, cls, *method = identifier.split("/")
            universe = self.universe(target) if target in TARGETS else None
            if not isinstance(universe, Universe) or cls not in universe.test_classes or \
                    (method and method[0] not in universe.all_methods(cls)):
                return f"its test {identifier} is not in the tested tree"
            listed.setdefault(target, set()).add(cls)
        allowed = paths | set(rule["consumers"])
        for target in TARGETS:
            universe = self.universe(target)
            if not isinstance(universe, Universe):
                return str(universe)
            for decl in universe.units:
                if decl.parent is None and decl.tokens & names and decl.path not in allowed and \
                        decl.name not in listed.get(target, set()):
                    return f"{decl.name} in {decl.path} reaches it but is not a listed test or consumer"
        sources = [path for path in self.tree.swift(PRODUCTION_DIRS) if path not in allowed]
        for path, text in self.tree.read(sources).items():
            if text is not None and names & set(IDENT.findall(clean(text))):
                return f"{path} reaches it but is not a listed consumer"
        return None

    def test_file(self, path, sides):
        """`sides` pairs each side's text with its changed code lines; their names resolve at the tested tree."""
        for target in self.targets_of(path):
            lane, universe = self.lanes[target], self.universe(target)
            if not isinstance(universe, Universe):
                lane.widen(f"{path}: {universe}.")
                continue
            found, universe.trail, universe.written = set(), set(), set()
            for text, numbers in sides:
                if text is not None and numbers:
                    decls, lines = scan(text, path)
                    found |= universe.changed(decls, lines, numbers)
            trail = sorted(universe.trail)
            via = f", through {', '.join(trail[:8])}{' and more' if len(trail) > 8 else ''}" if trail else ""
            lane.add(found, f"{path}: {len(found)} test identifier(s) reach its changed declarations{via}.")
            lane.written |= universe.written

    def other_file(self, path, deleted):
        readers = (self.ownership or {}).get("readers", {})
        reader = next((reader for prefix, reader in sorted(readers.items()) if path.startswith(prefix)), None)
        if reader is not None:
            target = PACKAGE if reader.startswith(PACKAGE_DIR) else HOSTED
            universe = self.universe(target)
            if isinstance(universe, Universe) and reader in universe.files:
                found = universe.reached({decl.name for decl in universe.files[reader]})
                self.lanes[target].add(found, f"{path}: {len(found)} test identifier(s) read it through {reader}.")
                return
            reason = f"{path}: its reader {reader} is not readable in {target}."
        elif path in self.rules:
            rule = self.rules[path]
            problem = self.rule_problem(rule, deleted)
            if problem is None:
                for target in TARGETS:
                    found = {test for test in rule["tests"] if test.startswith(f"{target}/")}
                    if found:
                        self.lanes[target].add(found, f"{path}: reviewed rule {rule['name']}.")
                return
            reason = f"{path}: rule {rule['name']} is stale: {problem}."
        elif self.ownership is None:
            reason = f"{path}: {OWNERSHIP} is missing or unreadable."
        else:
            reason = f"{path}: no reviewed rule bounds its consumers."
        for target in widened(path):
            self.lanes[target].widen(reason)


def plan(paths, base, head, tree, suites, path_suites, deleted=frozenset()):
    """The App test plan for a diff. `paths` are the changed paths, `base` the compared revision, `head` the other side
    (None: the working tree), `tree` the tested tree, `suites` the selected suites and `path_suites` the router's
    per-path classification."""
    planner = Planner(base, head, tree)
    app_paths = sorted(path for path in paths if "app" in path_suites(path))
    swift = [path for path in app_paths if path.endswith(".swift")]
    try:
        before, after = {}, {}
        for path in swift:
            for texts, revision in ((before, base), (after, head)):
                try:
                    texts[path] = git("show", f"{revision}:{path}").decode(errors="replace") if revision else None
                except subprocess.CalledProcessError:
                    texts[path] = None  # Added or deleted on this side.
        if head is None:
            after = Tree(None).read(swift)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        for lane in planner.lanes.values():
            lane.widen(f"Could not read the App diff ({error}).")
        app_paths = []
    for path in app_paths:
        try:
            if not path.endswith(".swift"):
                planner.other_file(path, set(deleted))
                continue
            old_numbers, new_numbers = code_changes(before[path], after[path])
            if not old_numbers and not new_numbers:
                for target in planner.targets_of(path) or widened(path):
                    planner.lanes[target].reasons.append(f"{path}: comments or whitespace only.")
            elif path.startswith((PACKAGE_DIR, HOSTED_DIR)):
                planner.test_file(path, ((before[path], old_numbers), (after[path], new_numbers)))
            else:
                planner.other_file(path, set(deleted))
        except Uncertain as error:
            for target in widened(path):
                planner.lanes[target].widen(f"{path}: {error}.")
    lanes = planner.lanes
    if "contracts" in suites and not lanes[PACKAGE].full:
        lanes[PACKAGE].add(set(CONTRACT_PROOF), "The contracts suite is selected: the live Web contract proof runs.")
    return {"version": 1, "base": base, "head": head or "working tree",
            "lanes": {target: lanes[target].result() for target in TARGETS}}


def full_plan(reason, base=None, head=None):
    return {"version": 1, "base": base, "head": head, "lanes": {
        target: {"mode": "full", "identifiers": [target], "reasons": [reason], "repeat": []} for target in TARGETS}}


def describe(result):
    """A readable plan for a terminal."""
    lines = [f"App test plan for {result['base']}..{result['head']}"]
    for target, lane in result["lanes"].items():
        count = f": {len(lane['identifiers'])} identifier(s)" if lane["mode"] == "explicit" else ""
        lines.append(f"{target} {lane['mode']}{count}")
        lines += [f"  run {identifier}" for identifier in lane["identifiers"] if lane["mode"] == "explicit"]
        lines += [f"  why {reason}" for reason in lane["reasons"]]
        lines += [f"  repeat {identifier}" for identifier in lane.get("repeat", [])]
    return "\n".join(lines)
