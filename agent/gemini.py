"""
Gemini client — the "brain" of MarkUp.

Supports key rotation: set GEMINI_API_KEY_2 and GEMINI_API_KEY_3 in .env
to automatically rotate between keys when rate limits are hit.
"""
import os
import json
import asyncio
import logging
import google.generativeai as genai

logger = logging.getLogger(__name__)

MODEL    = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
RETRIES  = 3
DELAY    = 2  # seconds between retries

# ── Key rotation pool ─────────────────────────────────────────────────────────

def _load_keys() -> list[str]:
    keys = [os.getenv(f"GEMINI_API_KEY{suffix}") for suffix in ("", "_2", "_3")]
    keys = [k for k in keys if k]
    if not keys:
        raise EnvironmentError("GEMINI_API_KEY is not set")
    return keys

_keys: list[str] = []
_key_index = 0

def _next_key() -> str:
    global _keys, _key_index
    if not _keys:
        _keys = _load_keys()
    key = _keys[_key_index % len(_keys)]
    _key_index += 1
    return key


# ── Main call ─────────────────────────────────────────────────────────────────

async def call_gemini(
    system_prompt: str,
    task_prompt: str,
    expect_json: bool = False,
) -> dict | str:
    """
    Call Gemini with retry + key rotation.

    - expect_json=True  → returns a parsed dict
    - expect_json=False → returns a plain string
    """
    last_error: Exception | None = None

    for attempt in range(RETRIES):
        try:
            genai.configure(api_key=_next_key())

            model = genai.GenerativeModel(
                model_name=MODEL,
                system_instruction=system_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,        # low temp = more predictable code
                    max_output_tokens=8192,
                ),
            )

            prompt = task_prompt
            if expect_json:
                prompt += "\n\nReturn valid JSON only — no markdown, no explanation."

            logger.info(f"Calling Gemini (attempt {attempt + 1}/{RETRIES})")

            # run_in_executor keeps the async event loop unblocked
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None, lambda: model.generate_content(prompt)
            )

            text = response.text.strip()

            if expect_json:
                # Strip markdown fences if Gemini added them
                if text.startswith("```"):
                    text = text.split("```")[1].lstrip("json").strip()
                return json.loads(text)

            return text

        except json.JSONDecodeError as e:
            logger.warning(f"Bad JSON from Gemini: {e} — retrying")
            last_error = e

        except Exception as e:
            if any(word in str(e).lower() for word in ("quota", "rate", "429")):
                logger.warning(f"Rate limit — rotating key, waiting {DELAY * (attempt + 1)}s")
            else:
                logger.error(f"Gemini error: {e}")
            last_error = e

        await asyncio.sleep(DELAY * (attempt + 1))

    raise RuntimeError(f"Gemini failed after {RETRIES} attempts: {last_error}")
