"""Release publishing must refuse mismatched or ambiguous artifacts."""
import hashlib
import gzip
import importlib.util
import io
import json
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

SPEC = importlib.util.spec_from_file_location(
    "publish_release", Path(__file__).resolve().parents[2] / "tools" / "publish_release.py"
)
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


def release_fixture(tmp_path, **overrides):
    manifest = {"publisher": "thalovant", "name": "thalovant-skills", "version": "0.1.0"}
    manifest.update(overrides)
    package = tmp_path / "thalovant-skills-0.1.0.vsix"
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr("extension/package.json", json.dumps(manifest))
        archive.writestr("extension.vsixmanifest", (
            '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
            '<Metadata><Identity Publisher="thalovant" Id="thalovant-skills" Version="0.1.0" />'
            '</Metadata></PackageManifest>'
        ))
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    release = {"tagName": "v0.1.0", "isDraft": False, "isPrerelease": False,
               "assets": [{"name": package.name, "digest": f"sha256:{digest}"}]}
    return package, release, digest


def test_accepts_exact_release(tmp_path):
    package, release, digest = release_fixture(tmp_path)
    assert publish.verify_release(tmp_path, "v0.1.0", release) == (package, "0.1.0", digest)


@pytest.mark.parametrize("overrides", [
    {"publisher": "someone-else"}, {"name": "other-extension"}, {"version": "0.2.0"}
])
def test_refuses_wrong_extension_identity(tmp_path, overrides):
    _, release, _ = release_fixture(tmp_path, **overrides)
    with pytest.raises(ValueError, match="publisher, extension name, or version"):
        publish.verify_release(tmp_path, "v0.1.0", release)


@pytest.mark.parametrize("tag", ["v0.1.0-beta", "main", "v0.1.0\nEVIL=1", "--latest"])
def test_refuses_unexpected_tags(tmp_path, tag):
    _, release, _ = release_fixture(tmp_path)
    with pytest.raises(ValueError, match="stable"):
        publish.verify_release(tmp_path, tag, release)


@pytest.mark.parametrize("field,value", [("tagName", "v0.2.0"), ("isDraft", True), ("isPrerelease", True)])
def test_refuses_nonmatching_or_unpublished_release(tmp_path, field, value):
    _, release, _ = release_fixture(tmp_path)
    release[field] = value
    with pytest.raises(ValueError, match="published, stable"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def test_refuses_changed_release_bytes(tmp_path):
    package, release, _ = release_fixture(tmp_path)
    with package.open("ab") as output:
        output.write(b"changed after release")
    with pytest.raises(ValueError, match="SHA-256"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def test_refuses_absent_github_digest(tmp_path):
    _, release, _ = release_fixture(tmp_path)
    del release["assets"][0]["digest"]
    with pytest.raises(ValueError, match="SHA-256"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def test_refuses_multiple_packages(tmp_path):
    _, release, _ = release_fixture(tmp_path)
    (tmp_path / "extra.vsix").write_bytes(b"extra")
    with pytest.raises(ValueError, match="exactly one"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def test_refuses_wrong_asset_name(tmp_path):
    _, release, _ = release_fixture(tmp_path)
    release["assets"][0]["name"] = "unexpected.vsix"
    with pytest.raises(ValueError, match="asset name"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def test_existing_marketplace_version_must_match_bytes():
    content = b"the original release"
    digest = hashlib.sha256(content).hexdigest()
    with patch.object(publish.urllib.request, "urlopen", return_value=download_response(content)):
        assert publish.marketplace_matches("0.1.0", digest)
    with patch.object(publish.urllib.request, "urlopen", return_value=download_response(b"different release")):
        with pytest.raises(ValueError, match="different bytes"):
            publish.marketplace_matches("0.1.0", digest)


@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
def test_service_failure_is_not_a_missing_version(status):
    error = urllib.error.HTTPError("https://example.test", status, "failed", {}, None)
    with patch.object(publish.urllib.request, "urlopen", side_effect=error):
        with pytest.raises(urllib.error.HTTPError):
            publish.marketplace_matches("0.1.0", "unused")


def test_only_not_found_permits_initial_publish():
    error = urllib.error.HTTPError("https://example.test", 404, "missing", {}, None)
    with patch.object(publish.urllib.request, "urlopen", side_effect=error):
        assert not publish.marketplace_matches("0.1.0", "unused")


@pytest.mark.parametrize("attribute,value", [("Publisher", "wrong"), ("Id", "wrong"), ("Version", "9.9.9")])
def test_refuses_conflicting_xml_identity(tmp_path, attribute, value):
    package, release, _ = release_fixture(tmp_path)
    with zipfile.ZipFile(package) as archive:
        manifest = archive.read("extension/package.json")
        xml = archive.read("extension.vsixmanifest").decode()
    old = {"Publisher": "thalovant", "Id": "thalovant-skills", "Version": "0.1.0"}[attribute]
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr("extension/package.json", manifest)
        archive.writestr("extension.vsixmanifest", xml.replace(f'{attribute}="{old}"', f'{attribute}="{value}"'))
    release["assets"][0]["digest"] = "sha256:" + hashlib.sha256(package.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="XML identity"):
        publish.verify_release(tmp_path, "v0.1.0", release)


def download_response(content, encoding="identity"):
    response = io.BytesIO(content)
    response.headers = {"Content-Encoding": encoding}
    return response


def test_marketplace_http_compression_is_not_part_of_the_vsix_hash():
    content = b"original VSIX bytes"
    digest = hashlib.sha256(content).hexdigest()
    with patch.object(publish.urllib.request, "urlopen", return_value=download_response(gzip.compress(content), "gzip")):
        assert publish.marketplace_matches("0.1.0", digest)


def test_unknown_http_encoding_fails_closed():
    with patch.object(publish.urllib.request, "urlopen", return_value=download_response(b"bytes", "unknown")):
        with pytest.raises(ValueError, match="Unsupported"):
            publish.marketplace_matches("0.1.0", "unused")
