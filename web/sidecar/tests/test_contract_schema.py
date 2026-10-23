"""The shared contract validator must understand the exported fixed cost ranges."""
from conftest import validate


def test_exported_cost_tuple_schema_is_checked():
    amount = {"type": "number", "minimum": 0}
    schema = {"type": "array", "prefixItems": [amount, amount], "items": False, "minItems": 2, "maxItems": 2}
    try:
        errors = validate([1, 3], schema)
    except TypeError as error:
        errors = [str(error)]
    assert errors == [], "valid declared cost range must match its exported schema"
    for invalid in ([1], [1, 3, 4], [1, "3"], [-1, 3], [True, 3]):
        assert validate(invalid, schema), invalid
    assert validate(1, True) == []
    assert validate(1, False)
    assert validate([1, 3], {"type": "array", "prefixItems": [amount], "items": amount}) == []
