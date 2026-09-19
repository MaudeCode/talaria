"""Tests for issue #4356: update check returns "can't check" for non-git installs."""
from unittest.mock import patch

import pytest
import api.updates as updates
from api import talaria_releases


@pytest.fixture(autouse=True)
def unavailable_release_metadata(monkeypatch):
    def unavailable(channel):
        raise talaria_releases.ReleaseUnavailable("Synthetic unavailable release metadata")
    monkeypatch.setattr(talaria_releases, "published_web_release", unavailable)


def test_check_repo_returns_no_git_sentinel_when_dot_git_absent(tmp_path):
    """_check_repo returns sentinel dict with no_git=True when .git is absent."""
    result = updates._check_repo(tmp_path, 'webui')

    assert result is not None
    assert isinstance(result, dict)
    assert result['name'] == 'webui'
    assert result['behind'] is None
    assert result['no_git'] is True


def test_check_repo_returns_no_git_sentinel_when_path_is_none():
    """_check_repo returns sentinel dict with no_git=True when path is None."""
    result = updates._check_repo(None, 'webui')

    assert result is not None
    assert isinstance(result, dict)
    assert result['name'] == 'webui'
    assert result['behind'] is None
    assert result['no_git'] is True


def test_check_repo_still_returns_dict_when_dot_git_exists(tmp_path):
    """The separate Agent checker retains its ordinary Git-checkout behavior."""
    (tmp_path / '.git').mkdir()

    def fake_git(args, cwd, timeout=10):
        if args == ['diff-index', '--quiet', 'HEAD', '--']:
            return '', True  # clean tree
        if args == ['fetch', 'origin', '--tags', '--force']:
            return 'network unreachable', False
        if args == ['tag', '--list', 'v*', '--sort=-v:refname']:
            return '', True
        raise AssertionError(f'unexpected git args: {args!r}')

    with patch.object(updates, '_run_git', side_effect=fake_git):
        result = updates._check_repo(tmp_path, 'agent')

    assert result is not None
    assert isinstance(result, dict)
    # When .git exists, no_git should not be in result or should be False
    assert result.get('no_git') is not True
