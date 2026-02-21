"""
Validator: final guardrail before patches are sent to GitLab.
Raises ValueError if any patch touches non-frontend files or contains dangerous code.
"""
import re
import logging
from agent.schemas import FilePatch

logger = logging.getLogger(__name__)

# Code patterns that should never appear in a frontend patch
DANGEROUS_PATTERNS = [
    (r"process\.env\.",                        "environment variable access"),
    (r"require\(['\"]fs['\"]",                 "Node.js filesystem access"),
    (r"require\(['\"]child_process['\"]",      "child process execution"),
    (r"exec\(|spawn\(|execSync\(",             "shell command execution"),
    (r"(password|secret|api_key)\s*=\s*['\"]", "hardcoded secret"),
    (r"eval\(|new Function\(",                 "dynamic code evaluation"),
    (r"DROP TABLE|DELETE FROM|INSERT INTO",    "SQL statement"),
]

# File types that must never be patched
BLOCKED_EXTENSIONS = [
    ".env", ".yml", ".yaml", ".sql", ".sh",
    ".py", ".rb", ".go", ".java",
    "Dockerfile", "docker-compose",
]


def validate_patches(patches: list[FilePatch]) -> list[FilePatch]:
    """
    Validates each patch. Returns the list unchanged if all pass,
    or raises ValueError describing the first violation.
    """
    for patch in patches:
        # Check file extension
        for ext in BLOCKED_EXTENSIONS:
            if patch.path.endswith(ext) or ext in patch.path:
                raise ValueError(f"Blocked: patch targets non-frontend file '{patch.path}'")

        # Check for dangerous code
        for pattern, description in DANGEROUS_PATTERNS:
            if re.search(pattern, patch.patched_content, re.IGNORECASE):
                raise ValueError(f"Blocked: dangerous pattern ({description}) in '{patch.path}'")

        logger.info(f"Validated: {patch.path}")

    return patches
