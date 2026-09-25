"""Archive a frozen bundle as regular files/directories, never archive links."""

import pathlib
import sys
import tarfile


def archive_bundle(source, destination):
    root = pathlib.Path(source).resolve(strict=True)

    def add(output, path, name, ancestors):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError(f"Bundle link escapes root: {name}")
        if resolved in ancestors:
            raise ValueError(f"Bundle directory cycle: {name}")
        info = output.gettarinfo(str(resolved), arcname=name)
        if info.isdir():
            output.addfile(info)
            for child in sorted(resolved.iterdir()):
                add(output, child, f"{name}/{child.name}", ancestors | {resolved})
        elif info.isfile():
            with resolved.open("rb") as stream:
                output.addfile(info, stream)
        else:
            raise ValueError(f"Unsupported bundle entry: {name}")

    try:
        with tarfile.open(destination, "w:gz", dereference=True) as output:
            add(output, root, root.name, set())
    except BaseException:
        pathlib.Path(destination).unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    archive_bundle(sys.argv[1], sys.argv[2])
