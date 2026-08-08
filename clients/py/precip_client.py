"""Client for the noaa-precip service.

SOURCE OF TRUTH: clients/py/precip_client.py in the noaa-precip repo. Vendored
into consumers by copying — if you are editing a copy, edit the original too or
the two will drift.

The service holds the NOAA token and the shared daily quota, so nothing here
talks to a weather provider directly. Configuration comes from the environment:

    PRECIP_API_URL    e.g. https://noaa-precip.vercel.app
    PRECIP_API_TOKEN  this consumer's bearer token
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import requests

DEFAULT_TIMEOUT = 30


class PrecipApiError(RuntimeError):
    """A structured failure from the service.

    `code` distinguishes the cases worth handling differently — notably
    ``no_centroid_for_zip`` (the ZIP has no geography, pass coordinates instead)
    and ``outside_nws_coverage`` — from a plain outage.
    """

    def __init__(self, status: int, code: str, detail: Any = None) -> None:
        super().__init__(f"{code} (HTTP {status})")
        self.status = status
        self.code = code
        self.detail = detail


class PrecipClient:
    """Thin HTTP client. One instance per process is plenty."""

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        session: requests.Session | None = None,
    ) -> None:
        resolved_url = base_url or os.environ.get("PRECIP_API_URL")
        resolved_token = token or os.environ.get("PRECIP_API_TOKEN")

        if not resolved_url:
            raise PrecipApiError(0, "missing_config", "PRECIP_API_URL is not set")
        if not resolved_token:
            raise PrecipApiError(0, "missing_config", "PRECIP_API_TOKEN is not set")

        self.base_url = resolved_url.rstrip("/")
        self.token = resolved_token
        self.timeout = timeout
        self.session = session or requests.Session()

    def _get(self, path: str, params: Mapping[str, Any]) -> dict[str, Any]:
        try:
            response = self.session.get(
                f"{self.base_url}{path}",
                params=dict(params),
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise PrecipApiError(0, "unreachable", str(exc)) from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise PrecipApiError(response.status_code, "bad_json", response.text[:200]) from exc

        if not response.ok:
            raise PrecipApiError(
                response.status_code,
                str(body.get("error", "unknown_error")),
                body.get("detail"),
            )
        return body

    def hourly(
        self,
        *,
        lat: float | None = None,
        lon: float | None = None,
        zip_code: str | None = None,
        start: str,
        end: str,
    ) -> dict[str, Any]:
        """Hourly precipitation, by coordinates or by ZIP. Max 366 days."""
        if zip_code is not None:
            params: dict[str, Any] = {"zip": zip_code}
        elif lat is not None and lon is not None:
            params = {"lat": lat, "lon": lon}
        else:
            raise PrecipApiError(0, "missing_location", "pass zip_code, or both lat and lon")

        return self._get("/api/v1/precip/hourly", {**params, "start": start, "end": end})

    def daily(self, zip_code: str, start: str, end: str) -> dict[str, Any]:
        """Daily precipitation for a ZIP. Max 366 days."""
        return self._get(
            "/api/v1/precip/daily", {"zip": zip_code, "start": start, "end": end}
        )

    def forecast(
        self,
        *,
        lat: float | None = None,
        lon: float | None = None,
        zip_code: str | None = None,
        days: int = 7,
    ) -> dict[str, Any]:
        """Up to 7 days of forecast, counted from today at the site."""
        if zip_code is not None:
            params: dict[str, Any] = {"zip": zip_code}
        elif lat is not None and lon is not None:
            params = {"lat": lat, "lon": lon}
        else:
            raise PrecipApiError(0, "missing_location", "pass zip_code, or both lat and lon")

        return self._get("/api/v1/precip/forecast", {**params, "days": days})
