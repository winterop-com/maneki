"""mDNS register / unregister smoke test for the audio serve.

The TUI's browse-listener code (and its tests) were removed along with
the rest of the TUI in favour of the web SPA. What's left is the audio
server's outbound advertise side, which still uses Zeroconf.
"""

from __future__ import annotations

from mediakit.audio.serve.discovery import register_service, unregister_service


def test_register_then_unregister_smoke() -> None:
    """register_service starts Zeroconf and unregister_service tears it down without raising."""
    handle = register_service(port=14533, instance_name="mediakit-test-smoke")
    if handle is None:
        # CI environments without IPv4 multicast still pass the test by skipping.
        import pytest

        pytest.skip("Zeroconf could not start (likely no multicast iface in this environment)")
    zc, info = handle
    try:
        assert info.name.startswith("mediakit-test-smoke.")
        assert info.port == 14533
        # `properties` round-trips as bytes — flatten + decode for the check.
        props = {k.decode(): v.decode() for k, v in info.properties.items() if isinstance(v, bytes)}
        assert props["type"] == "mediakit"
        assert props["openSubsonic"] == "true"
    finally:
        unregister_service(zc, info)
