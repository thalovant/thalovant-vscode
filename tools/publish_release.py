"""Validate and compare the existing release package; never rebuild or publish it."""
import argparse
import hashlib
import gzip
import json
import os
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

PUBLISHER = "thalovant"
EXTENSION = "thalovant-skills"


def verify_release(directory: Path, tag: str, release: dict) -> tuple[Path, str, str]:
    """Require one correctly named, identified package matching GitHub's asset digest."""
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Marketplace publishing requires a stable vMAJOR.MINOR.PATCH release tag")
    if release.get("tagName") != tag or release.get("isDraft") or release.get("isPrerelease"):
        raise ValueError("The release must be published, stable, and match the requested tag")
    assets = [asset for asset in release["assets"] if asset["name"].endswith(".vsix")]
    packages = list(directory.glob("*.vsix"))
    if len(assets) != 1 or len(packages) != 1:
        raise ValueError("The release must carry exactly one VSIX")
    version = tag[1:]
    expected_name = f"{EXTENSION}-{version}.vsix"
    package, asset = packages[0], assets[0]
    if package.name != expected_name or asset["name"] != expected_name:
        raise ValueError("Unexpected VSIX asset name")
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    if asset.get("digest") != f"sha256:{digest}":
        raise ValueError("The downloaded VSIX does not match GitHub's SHA-256 asset digest")
    with zipfile.ZipFile(package) as archive:
        if archive.namelist().count("extension/package.json") != 1:
            raise ValueError("Expected exactly one extension manifest")
        manifest = json.loads(archive.read("extension/package.json"))
        if archive.namelist().count("extension.vsixmanifest") != 1:
            raise ValueError("Expected exactly one VSIX manifest")
        xml_manifest = ET.fromstring(archive.read("extension.vsixmanifest"))
        identities = xml_manifest.findall("{*}Metadata/{*}Identity")
        if len(identities) != 1 or tuple(identities[0].get(key) for key in (
            "Publisher", "Id", "Version"
        )) != (PUBLISHER, EXTENSION, version):
            raise ValueError("The VSIX XML identity does not match this release")
    if (manifest.get("publisher"), manifest.get("name"), manifest.get("version")) != (
        PUBLISHER, EXTENSION, version
    ):
        raise ValueError("The VSIX publisher, extension name, or version does not match this release")
    return package, version, digest


def marketplace_matches(version: str, digest: str) -> bool:
    """Return false only for a missing version; reject a different existing package."""
    url = (f"https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{PUBLISHER}"
           f"/vsextensions/{EXTENSION}/{version}/vspackage")
    request = urllib.request.Request(url, headers={"User-Agent": "thalovant-release-verifier"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read()
            encoding = response.headers.get("Content-Encoding", "identity").lower()
            if encoding == "gzip":
                content = gzip.decompress(content)
            elif encoding != "identity":
                raise ValueError(f"Unsupported Marketplace content encoding: {encoding}")
            actual = hashlib.sha256(content).hexdigest()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise
    if actual != digest:
        raise ValueError(f"Marketplace already has {version} with different bytes; refusing to overwrite")
    return True


def main() -> None:
    """Emit workflow outputs or verify eventual public availability after publishing."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "compare", "verify"))
    parser.add_argument("--directory", type=Path, default=Path("release"))
    args = parser.parse_args()
    if args.mode == "prepare":
        release = json.loads((args.directory / "release.json").read_text())
        package, version, digest = verify_release(args.directory, os.environ["TAG"], release)
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
            output.write(f"VSIX={package}\nVERSION={version}\nVSIX_SHA256={digest}\n")
        print(f"Verified {PUBLISHER}.{EXTENSION} {version}: sha256 {digest}")
        return
    version, digest = os.environ["VERSION"], os.environ["VSIX_SHA256"]
    if args.mode == "compare":
        found = marketplace_matches(version, digest)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"published={str(found).lower()}\n")
        print(f"Marketplace {'already carries the exact release' if found else 'does not yet carry this version'}.")
        return
    for attempt in range(24):
        if marketplace_matches(version, digest):
            print(f"Marketplace publicly serves the exact {version} release package.")
            return
        if attempt < 23:
            time.sleep(15)
    raise RuntimeError("Marketplace has not exposed the package yet; rerun to verify after processing completes")


if __name__ == "__main__":
    main()
