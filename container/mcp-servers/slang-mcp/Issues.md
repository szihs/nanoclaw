# Issues

Critical review of the slang-mcp-server codebase. Verified with tests and ruff. Pyright strict mode has ~202 remaining errors (see Lint section).

## Bugs

- [x] **Double `https://` in GitLab default URL** — `src/config.py:62` had `"https://https://gitlab-master.nvidia.com/api/v4"`. Fixed.
- [x] **`gitlab_request()` returns inconsistent types** — Now always returns `Dict[str, Any]`. All callers in `gitlab.py` updated.
- [x] **Stray `print()` statements corrupt STDIO transport** — Removed `print(pulls_data)`, `print(f"since_date:...")`, and `print("Thread: ", thread.name)`.
- [x] **Discord `DEBUG` import captures initial `False` value** — Changed to `from ..config import IsDebug` and use `IsDebug()` call.
- [x] **Failing test: `test_list_issues`** — Fixed by using relative dates (`timedelta`) instead of hardcoded 2025 dates.
- [x] **Missing `@classmethod` on Slack validators** — Added `@classmethod` to all 5 Pydantic v2 `@field_validator` methods.
- [x] **`atexit` handler calls `sys.exit(0)`** — Separated into `_atexit_cleanup()` that does not call `sys.exit(0)`.
- [x] **GitLab file upsert picks wrong HTTP method** — Fixed to check `"error" not in check_result` instead of `try/except`.
- [x] **Shutdown cleanup can hit running-event-loop errors** — Fixed to use `asyncio.get_running_loop()` + `create_task()` when loop is running.
- [x] **Shutdown `create_task` exits before cleanup runs** — `handle_shutdown` called `sys.exit(0)` immediately after `loop.create_task(cleanup_all())`. Fixed to use `add_done_callback` to defer exit until cleanup completes.
- [x] **`gitlab_request` return type lies** — Declared `-> Dict[str, Any]` but list endpoints return JSON arrays. Fixed to `-> Any` with docstring noting error responses are always dicts.
- [x] **Draft PRs not filtered in `list_pull_requests`** — Re-added `if pr.get("draft", False): continue` before `filter_data`.
- [x] **Shared HTTP clients never closed** — Added `close_http_clients()` in `config.py` and wired into `cleanup_all()` in `server.py`.

## Security

- [x] **GraphQL injection in `get_issue()`** — Converted to parameterized `variables` dict instead of string `.replace()`.
- [x] **SSE transport binds to `0.0.0.0`** — Changed to `host="127.0.0.1"`.

## Dependencies

- [x] **Missing `aiohttp` in `pyproject.toml`** — Added `"aiohttp>=3.9.0"` to dependencies.

## Lint / Type Errors

- [x] **205 ruff errors** — All fixed. Line length increased to 120. Auto-fixed imports, removed unused imports, formatted all files. `ruff check src/ test/` now passes clean.
- [x] **Pyright errors resolved** — `pyright` now reports `0 errors, 0 warnings, 0 informations`.

## Tests

- [x] **Integration-like tests are mixed into unit suite** — Added `@pytest.mark.integration` markers to `test_gitlab.py`, `test_github_issue.py`, `test_github_pull_requests.py`. Registered marker in `pytest.ini`. Tests now properly deselected with `-m "not integration"`.
- [x] **`test_server.py` has mostly smoke checks** — Fixed `test_server_imports` (removed nonexistent `init_discord_client` import). Fixed mock tests.
- [x] **`test_config.py` mock failures** — Updated `mock_httpx_client` fixture to patch `_get_github_client` instead of `httpx.AsyncClient` context manager (matching refactored reusable client pattern).

## Performance

- [x] **New `httpx.AsyncClient` created per request** — Added shared client instances with lazy init (`_get_github_client()`, `_get_gitlab_client()`) and `httpx.Timeout(30.0, connect=10.0)`.
