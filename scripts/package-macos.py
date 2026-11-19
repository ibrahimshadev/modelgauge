"""Assemble and verify a WSL-built Tauri release. Called by package-macos.sh."""
import filecmp
import hashlib
import json
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def sha256(data):
    return hashlib.sha256(data).digest()


def check_executable(binary, cpu, slots):
    data = binary.read_bytes()
    magic, arch, _, kind = struct.unpack_from("<4I", data)
    assert (magic, arch, kind) == (0xfeedfacf, cpu, 2), binary
    target = subprocess.check_output(["rcodesign", "extract", "macho-target", binary], text=True)
    assert "Platform: macOS\nMinimum OS: 13.5.0\n" in target, target
    cd = subprocess.check_output(["rcodesign", "extract", "code-directory-raw", binary])
    magic, length, _, flags, hashes, _, special, pages, limit = struct.unpack_from(">9I", cd)
    size, algorithm, _, shift = struct.unpack_from("4B", cd, 36)
    assert (magic, length, size, algorithm) == (0xfade0c02, len(cd), 32, 2), binary
    page_size = 1 << shift
    assert 0 < limit < len(data) and pages == (limit + page_size - 1) // page_size, binary
    for i in range(pages):
        chunk = data[i * page_size:min(limit, (i + 1) * page_size)]
        assert sha256(chunk) == cd[hashes + i * size:hashes + (i + 1) * size], (binary, i)
    for slot, raw in slots.items():
        assert flags & 2 and special >= slot, binary
        assert sha256(raw) == cd[hashes - slot * size:hashes - (slot - 1) * size], slot
    return sha256(cd)[:20]


def package(arch, built):
    cpu, label = {"x86_64": (0x1000007, "x64"), "aarch64": (0x100000c, "arm64")}[arch]
    config = json.loads(Path("src-tauri/tauri.conf.json").read_text())
    sidecar_path, = config["bundle"]["externalBin"]
    sidecar = Path(sidecar_path).name
    version = config["version"]
    name = config["productName"]
    stem = f"{name}-{version}-mac-{label}"
    destination = Path("release") / f"{stem}.zip"
    destination.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory(dir="release") as publish:
        app = Path(temp) / f"{name}.app"
        contents = app / "Contents"
        binaries = contents / "MacOS"
        resources = contents / "Resources"
        binaries.mkdir(parents=True)
        resources.mkdir()
        for source, dest in [(built / "modelgauge", binaries / name), (built / sidecar, binaries / sidecar)]:
            shutil.copyfile(source, dest)
            dest.chmod(0o755)
        for source, rel in config["bundle"]["resources"].items():
            assert filecmp.cmp(Path("src-tauri") / source, built / rel, shallow=False), rel
            dest = resources / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(built / rel, dest)
        shutil.copyfile("assets/icon.icns", resources / "icon.icns")
        info = plistlib.loads(Path("src-tauri/Info.plist").read_bytes())
        info.update(CFBundleName=name, CFBundleDisplayName=name, CFBundleExecutable=name,
                    CFBundleIdentifier=config["identifier"], CFBundlePackageType="APPL",
                    CFBundleIconFile="icon.icns", CFBundleInfoDictionaryVersion="6.0",
                    CFBundleShortVersionString=version, CFBundleVersion=version,
                    LSMinimumSystemVersion="13.5", LSApplicationCategoryType="public.app-category.utilities")
        assert info["LSUIElement"] is True
        (contents / "Info.plist").write_bytes(plistlib.dumps(info))
        # Keep Node's upstream signature and JIT entitlements when sealing the host.
        subprocess.run(["rcodesign", "sign", "--config-file", "/dev/null", "--timestamp-url", "none",
                        "--exclude", f"Contents/MacOS/{sidecar}", app], check=True)
        staged_node = Path("src-tauri") / f"{sidecar_path}-{arch}-apple-darwin"
        assert filecmp.cmp(binaries / sidecar, staged_node, shallow=False)
        seal = (contents / "_CodeSignature/CodeResources").read_bytes()
        files = plistlib.loads(seal)["files2"]
        check_executable(binaries / name, cpu, {1: (contents / "Info.plist").read_bytes(), 3: seal})
        assert files[f"MacOS/{sidecar}"]["cdhash"] == check_executable(binaries / sidecar, cpu, {})
        for resource in resources.rglob("*"):
            if resource.is_file():
                assert files[str(resource.relative_to(contents))]["hash2"] == sha256(resource.read_bytes()), resource
        stage = Path(publish).resolve() / stem
        stage.mkdir()
        archive = stage / f"{stem}.zip"
        subprocess.run(["zip", "-q", "-r", archive, app.name], cwd=temp, check=True)
        subprocess.run(["unzip", "-q", archive, "-d", stage], check=True)
        with zipfile.ZipFile(archive) as zipped:
            for binary in binaries.iterdir():
                mode = zipped.getinfo(str(binary.relative_to(temp))).external_attr >> 16
                assert stat.S_ISREG(mode) and mode & 0o111 == 0o111, binary
        subprocess.run(["diff", "-qr", app, stage / app.name], check=True)
        archive.replace(destination)
    print(destination)


if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("Package verification requires Python assertions")
    package(sys.argv[1], Path(sys.argv[2]))
