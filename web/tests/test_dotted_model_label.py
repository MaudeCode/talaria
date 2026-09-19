from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.resolve()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.config import _get_label_for_model  # noqa: E402

def _derive_set_from_config(marker: str) -> set[str]:
    """Read an allow-list out of PRODUCTION source instead of retyping it.

    A retyped copy silently stops matching when the real set grows -- which is
    exactly how ``global`` and then ``luma``/``twelvelabs``/``ibm`` shipped
    mislabeled. Same technique as test_every_catalog_dotted_id_loses_its_routing_prefix.
    """
    import re as _re
    config_src = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
    start = config_src.index(marker)
    body = config_src[start:config_src.index("}", start)]
    found = {m.lower() for m in _re.findall(r'"([a-z0-9-]+)"', body)}
    assert found, f"could not derive {marker!r} from api/config.py"
    return found


_PRODUCTION_REGIONS = _derive_set_from_config("_regions = {")

# (model_id, expected_normalized_id) — what the dotted-prefix step must leave
# behind, BEFORE the shared cosmetic title-casing that both sides apply after.
STRIP_CASES = [
    # --- documented Bedrock/Vertex shapes: prefix is plumbing --------------
    ("us.anthropic.claude-opus-5", "claude-opus-5"),
    ("eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
     "claude-sonnet-4-5-20250929-v1"),
    ("apac.anthropic.claude-haiku-4", "claude-haiku-4"),
    # ``global`` is a routing head the catalog actually ships (six
    # ``global.anthropic.claude-*`` IDs at api/config.py:1901-1909, and the
    # first-party routing notes use it as the canonical Bedrock shape). Omitting
    # it from the region set left every one of those labels reading
    # "Global.anthropic.claude Opus 4 7".
    ("global.anthropic.claude-opus-4-7", "claude-opus-4-7"),
    ("global.anthropic.claude-opus-4-6-v1", "claude-opus-4-6-v1"),
    ("global.anthropic.claude-sonnet-4-6", "claude-sonnet-4-6"),
    ("global.anthropic.claude-opus-4-5-20251101-v1:0",
     "claude-opus-4-5-20251101-v1"),
    ("global.anthropic.claude-sonnet-4-5-20250929-v1:0",
     "claude-sonnet-4-5-20250929-v1"),
    ("global.anthropic.claude-haiku-4-5-20251001-v1:0",
     "claude-haiku-4-5-20251001-v1"),
    ("us-gov.anthropic.claude-opus-5", "claude-opus-5"),
    ("mistral.mistral-large-2407-v1:0", "mistral-large-2407-v1"),
    ("amazon.nova-pro-v1:0", "nova-pro-v1"),
    ("meta.llama3-70b-instruct-v1:0", "llama3-70b-instruct-v1"),
    # --- must be left BYTE-INTACT ------------------------------------------
    # Vendor is the whole name: stripping it would render the model as "V3".
    ("deepseek.v3", "deepseek.v3"),
    # Uncatalogued vendor: not our shape, do not touch.
    ("foo.bar.baz", "foo.bar.baz"),
    ("acme.super-model-9", "acme.super-model-9"),
    # A known region head with an unknown vendor is not our shape either.
    ("us.foo.bar", "us.foo.bar"),
    # Version dots must survive.
    ("gpt-4.1", "gpt-4.1"),
    ("qwen3.6-35b", "qwen3.6-35b"),
    ("o1.5-preview", "o1.5-preview"),
    # URI-scheme IDs are paths, not dotted namespaces.
    ("https://host/v1.2/model", "https://host/v1.2/model"),
    # No dot at all.
    ("claude-opus-5", "claude-opus-5"),
]

# End-to-end labels through the real backend function.
LABEL_CASES = [
    ("us.anthropic.claude-opus-5", "Claude Opus 5"),
    ("mistral.mistral-large-2407-v1:0", "Mistral Large 2407 V1"),
    ("gpt-4.1", "GPT 4.1"),
    ("qwen3.6-35b", "Qwen3.6 35B"),
]


@pytest.mark.parametrize("model_id,expected", LABEL_CASES)
def test_backend_label_drops_dotted_plumbing(model_id, expected):
    assert _get_label_for_model(model_id, []) == expected


@pytest.mark.parametrize("model_id", [
    "deepseek.v3", "foo.bar.baz", "acme.super-model-9", "us.foo.bar",
])
def test_backend_label_keeps_uncatalogued_vendor_name(model_id):
    """The vendor word must not be silently deleted from an unknown ID."""
    vendor = model_id.split(".")[0]
    label = _get_label_for_model(model_id, [])
    assert vendor.lower() in label.lower(), (
        f"{model_id!r} lost its vendor: label={label!r}"
    )


# Reuses the boundary-slicing approach already proven in
# tests/test_issue3429_uri_scheme_model_label.py: regex literals inside
# getModelLabel() defeat a naive brace counter, so bound it by the next
# top-level function instead.
_GET_MODEL_LABEL_DRIVER = r"""
const fs = require('fs');
const ui = fs.readFileSync(process.argv[1], 'utf8');
const start = ui.indexOf('function getModelLabel(');
if (start < 0) throw new Error('getModelLabel not found');
const after = ui.indexOf('\nfunction _gatewayProviderName(', start);
if (after < 0) throw new Error('getModelLabel end boundary not found');
// Sinks only: no catalog has been fetched yet, so dynamic labels are empty.
const _dynamicModelLabels = {};
function _fmtOllamaLabel(s){ return s; }
// The dotted normalizer and the two Sets it closes over sit just above
// getModelLabel(); without them the eval'd function ReferenceErrors.
const _stripStart = ui.indexOf('const _BEDROCK_REGION_PREFIXES');
if (_stripStart < 0 || _stripStart > start) throw new Error('strip block not found');
eval(ui.slice(_stripStart, start));
eval(ui.slice(start, after));
const out = {};
for (const m of JSON.parse(process.argv[2])) out[m] = getModelLabel(m);
process.stdout.write(JSON.stringify(out));
"""


def test_every_catalog_dotted_id_loses_its_routing_prefix():
    """Catalog-driven guard against region/vendor-set drift.

    The allow-lists and the shipped catalog are two lists that must agree. They
    didn't, twice: first ``global`` was missing (six IDs mislabeled), then
    ``luma``/``twelvelabs``/``ibm`` were missing (real Bedrock vendors rendering
    as "Us.luma.ray 2").

    An earlier version of this test scraped only three-segment
    ``<region>.<vendor>.<model>`` literals and therefore inspected **6** of the
    **75** dotted catalog IDs — reassuring, but nearly blind. This version:

    - scrapes ANY quoted ``id`` value (single or double quotes, any segment count);
    - derives the offending prefixes from the PRODUCTION allow-lists rather than a
      retyped copy, so a set that grows without test updates is still covered;
    - skips version dots (``qwen3.6-plus``, ``gpt-5.4``), which are not namespaces.
    """
    import re as _re

    config_src = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")

    # Derive the real allow-lists out of production source, don't retype them.
    def _set_literal(marker: str) -> set[str]:
        start = config_src.index(marker)
        body = config_src[start:config_src.index("}", start)]
        return {m.lower() for m in _re.findall(r'"([a-z0-9-]+)"', body)}

    regions = _set_literal("_regions = {")
    vendors = _set_literal("_vendors = {")
    assert regions and vendors, "could not derive allow-lists from api/config.py"
    namespace_heads = regions | vendors

    ids = {
        i for i in _re.findall(r"""['"]id['"]\s*:\s*['"]([^'"]+)['"]""", config_src)
        if "." in i
    }
    assert len(ids) > 20, f"catalog scrape found only {len(ids)} dotted ids"

    offenders = []
    for model_id in sorted(ids):
        head = model_id.split(".")[0].lower()
        # Only IDs whose head is a KNOWN namespace should be stripped; a version
        # dot such as `qwen3.6-plus` has no namespace head and is left alone.
        if head not in namespace_heads:
            continue
        label = _get_label_for_model(model_id, [])
        if head in label.lower().replace(" ", "."):
            offenders.append((model_id, label))

    assert not offenders, (
        "catalog IDs still carry a routing/vendor prefix in their label — add the "
        f"missing head to the region/vendor sets: {offenders}"
    )


def test_known_bedrock_vendors_are_all_covered():
    """Real Bedrock foundation-model vendors must all be in the allow-list.

    These were shipping mislabeled: `luma.ray-2` rendered as "Luma.ray 2",
    `us.twelvelabs.marengo-embed-2-7` as "Us.twelvelabs.marengo Embed 2 7".

    The assertion is that no DOTTED NAMESPACE survives — not that the vendor word
    is absent, because a vendor legitimately reappears inside some model names
    (``mistral.mistral-large-2407`` → "Mistral Large 2407").
    """
    for model in [
        "luma.ray-2",
        "twelvelabs.marengo-embed-2-7",
        "ibm.granite-3-8b-instruct",
        "anthropic.claude-opus-5",
        "amazon.nova-pro-v1:0",
        "mistral.mistral-large-2407-v1:0",
    ]:
        head = model.split(".")[0]
        label = _get_label_for_model(model, [])
        assert f"{head}." not in label.lower(), (
            f"{model!r} kept its vendor namespace: {label!r}"
        )
        # And with a region prefix in front.
        regional = f"us.{model}"
        rlabel = _get_label_for_model(regional, [])
        assert "us." not in rlabel.lower() and f"{head}." not in rlabel.lower(), (
            f"{regional!r} kept its namespace: {rlabel!r}"
        )



def test_backend_uses_a_closed_allow_list():
    """Guard the design: the fix must not regress to a generic prefix loop."""
    config_src = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
    idx = config_src.index("def _get_label_for_model")
    block = config_src[idx:idx + 4000]
    assert "_regions" in block and "_vendors" in block, (
        "the dotted-prefix strip must be gated on explicit provider allow-lists"
    )
    assert "while _i < len(_segs) - 1 and _segs[_i].isalpha()" not in block, (
        "the generic letters-only loop rewrites uncatalogued IDs"
    )
