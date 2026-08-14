"""Tests for the public demo's guard rails.

These cover the properties that make the demo safe to expose without a login.
They test `app.demo` directly rather than through the running app because the
mode is resolved from the environment at import time, and the point of these
tests is the policy - what is reachable, what is cached, what is throttled -
not the wiring that applies it.
"""

from __future__ import annotations

from app import demo


class TestAllowlist:
    def test_read_methods_only(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            assert not demo.is_allowed(method, "/v1/sessions")
        for method in ("GET", "HEAD", "OPTIONS"):
            assert demo.is_allowed(method, "/v1/sessions")

    def test_pages_and_read_apis_are_public(self) -> None:
        for path in (
            "/",
            "/dashboard",
            "/alerts",
            "/stt-evaluation",
            "/v1/alerts",
            "/ready",
            "/v1/demo/config",
            "/v1/sessions",
            "/v1/dashboard/summary",
            "/assets/styles.css",
            "/v1/sessions/abc-123",
            "/v1/sessions/abc-123/audio/call",
            "/v1/sessions/abc-123/audio/call/peaks",
        ):
            assert demo.is_allowed("GET", path), path

    def test_everything_else_is_refused(self) -> None:
        """The allowlist must not be widened by an unlisted route appearing."""
        for path in (
            "/onboarding",
            "/v1/config",
            "/v1/keys",
            "/v1/sessions/abc/complete",
            "/v1/ingest",
            "/docs",
            "/openapi.json",
        ):
            assert not demo.is_allowed("GET", path), path

    def test_traversal_cannot_widen_the_surface(self) -> None:
        for path in (
            "/assets/../app/main.py",
            "/v1/sessions/../../etc/passwd",
            "/v1/sessions/abc/audio/call/../../../keys",
        ):
            assert not demo.is_allowed("GET", path), path

    def test_trailing_slash_is_the_same_resource(self) -> None:
        assert demo.is_allowed("GET", "/ready/")
        assert demo.is_allowed("GET", "/dashboard/")

    def test_only_known_audio_tracks(self) -> None:
        assert demo.is_allowed("GET", "/v1/sessions/abc/audio/mixed")
        assert not demo.is_allowed("GET", "/v1/sessions/abc/audio/secret")


class TestHeaders:
    def test_media_and_assets_cache_differently(self) -> None:
        assert demo.cache_control("/assets/app.js") == demo.IMMUTABLE_CACHE
        assert demo.cache_control("/v1/sessions/a/audio/call") == demo.MEDIA_CACHE
        assert demo.cache_control("/v1/sessions") == demo.API_CACHE
        assert demo.cache_control("/dashboard") == demo.PAGE_CACHE
        assert demo.cache_control("/alerts") == demo.PAGE_CACHE

    def test_every_response_is_hardened(self) -> None:
        headers = demo.security_headers("/dashboard")
        assert "default-src 'self'" in headers["Content-Security-Policy"]
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert "noindex" in headers["X-Robots-Tag"]

    def test_demo_pages_may_be_framed_only_by_the_marketing_site(self) -> None:
        csp = demo.security_headers("/dashboard")["Content-Security-Policy"]
        assert "frame-ancestors 'self' https://www.vaanieval.com" in csp
        assert "object-src 'none'" in csp

    def test_no_third_party_script_without_configured_analytics(self) -> None:
        """The default posture loads nothing from anyone else."""
        csp = demo.security_headers("/dashboard")["Content-Security-Policy"]
        assert "script-src 'self' 'unsafe-inline';" in csp
        assert "connect-src 'self';" in csp
        assert "googletagmanager" not in csp
        assert "google-analytics" not in csp

    def test_analytics_widens_only_the_hosts_it_needs(self) -> None:
        """And when it is configured, only measurement hosts are added."""
        csp = demo.security_headers("/dashboard", analytics=True)["Content-Security-Policy"]
        assert "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com;" in csp
        assert "https://www.google-analytics.com" in csp
        # Widening measurement must not relax anything structural.
        assert "frame-ancestors 'self' https://www.vaanieval.com" in csp
        assert "object-src 'none'" in csp
        assert "form-action 'none'" in csp
        assert "media-src 'self' blob:;" in csp


class TestMediaLimiter:
    def test_media_is_recognised_but_metadata_is_not(self) -> None:
        assert demo.is_media("/v1/sessions/a/audio/call")
        assert not demo.is_media("/v1/sessions/a/audio/call/peaks")
        assert not demo.is_media("/v1/sessions")

    def test_burst_is_allowed_then_refused(self) -> None:
        limiter = demo.MediaLimiter(burst=3, per_second=1.0)
        assert [limiter.allow("client", 0.0) for _ in range(3)] == [True] * 3
        assert not limiter.allow("client", 0.0)

    def test_budget_refills_over_time(self) -> None:
        limiter = demo.MediaLimiter(burst=2, per_second=1.0)
        limiter.allow("client", 0.0)
        limiter.allow("client", 0.0)
        assert not limiter.allow("client", 0.0)
        assert limiter.allow("client", 1.0)

    def test_clients_are_independent(self) -> None:
        limiter = demo.MediaLimiter(burst=1, per_second=1.0)
        assert limiter.allow("a", 0.0)
        assert not limiter.allow("a", 0.0)
        assert limiter.allow("b", 0.0)

    def test_client_table_is_bounded(self) -> None:
        """An unbounded table keyed by caller is itself a way to exhaust us."""
        limiter = demo.MediaLimiter(burst=5, per_second=1.0, max_clients=4)
        for index in range(50):
            limiter.allow(f"client-{index}", float(index))
        assert len(limiter._clients) <= 4

    def test_forwarded_address_is_preferred_behind_a_proxy(self) -> None:
        class Request:
            def __init__(self, headers: dict[str, str], host: str) -> None:
                self.headers = headers
                self.client = type("C", (), {"host": host})()

        assert demo.client_key(Request({"x-forwarded-for": "1.2.3.4, 5.6.7.8"}, "10.0.0.1")) == "1.2.3.4"
        assert demo.client_key(Request({}, "10.0.0.1")) == "10.0.0.1"
