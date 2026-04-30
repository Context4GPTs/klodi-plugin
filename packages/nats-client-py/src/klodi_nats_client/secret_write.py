"""Atomic secret-file write — TOCTOU-free.

Closes P1-8 from the 2026-04-26 multi-lens review:
``write(path, body)`` followed by ``chmod(path, 0o600)`` leaves a window
where the secret file is world-readable. This helper opens the file
with the secure mode set at creation time and uses a temp-then-rename
to avoid races, both for first-write and re-registration.

Usage::

    from klodi_nats_client.secret_write import klodi_secret_write
    klodi_secret_write(creds_path, nats_creds_text)
    klodi_secret_write(config_path, json.dumps(config))
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("klodi_nats_client.secret_write")

DEFAULT_MODE = 0o600


def klodi_secret_write(
    path: str | os.PathLike[str],
    body: str | bytes,
    mode: int = DEFAULT_MODE,
) -> Path:
    """Write ``body`` to ``path`` such that the file is never readable
    by other users at any point during the write.

    Algorithm:
      1. Open a sibling ``<path>.tmp`` with ``O_WRONLY|O_CREAT|O_EXCL``
         and the requested mode — fails if that exact name exists, no
         symlink chase.
      2. Write the body, fsync, close.
      3. ``os.chmod`` defensively (in case umask widened the bits).
      4. ``os.replace`` atomically over the target.

    Failures unlink the temp so a stale 0o600 .tmp can't accumulate.

    Returns the final path on success; raises on failure.
    """
    target = Path(path)
    tmp = target.with_suffix(target.suffix + ".tmp")

    payload = body.encode("utf-8") if isinstance(body, str) else body

    if tmp.exists():
        # A prior failed run may have left a .tmp at the secure mode.
        # Unlink so the O_EXCL open below succeeds.
        try:
            tmp.unlink()
        except OSError as err:
            raise OSError(
                f"klodi_secret_write: leftover temp at {tmp}; could not unlink ({err})"
            ) from err

    fd = os.open(
        os.fspath(tmp),
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        mode,
    )
    try:
        try:
            written = 0
            while written < len(payload):
                written += os.write(fd, payload[written:])
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.chmod(tmp, mode)
        except OSError as err:
            log.warning("klodi_secret_write_chmod_failed path=%s err=%s", tmp, err)
        os.replace(tmp, target)
    except BaseException:
        # On any failure between the create and the rename, scrub the
        # temp so an attacker can't read a half-written secret.
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        except OSError as err:
            log.warning(
                "klodi_secret_write_cleanup_failed path=%s err=%s", tmp, err,
            )
        raise

    return target


__all__ = ["DEFAULT_MODE", "klodi_secret_write"]
