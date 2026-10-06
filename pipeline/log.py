"""Warnings that show up on the GitHub Actions run page, not only inside the log."""
import os

WARNINGS = []


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::warning::{msg}", flush=True)     # becomes an annotation on the run summary
    else:
        print(f"  ! {msg}", flush=True)


def write_summary(lines) -> None:
    """Append markdown to the run's summary page (no-op outside GitHub Actions)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")
