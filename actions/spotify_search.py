"""Spotify Web API: client-credentials token + search (shared by HTTP route and music actions)."""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from itertools import zip_longest
from time import time

__all__ = [
    "SpotifyNotConfiguredError",
    "SpotifyUpstreamError",
    "search_tracks_normalized",
    "search_albums_normalized",
    "search_catalog_normalized",
    "album_tracks_normalized",
    "artist_top_tracks_normalized",
    "artist_albums_normalized",
]


class SpotifyNotConfiguredError(RuntimeError):
    pass


class SpotifyUpstreamError(RuntimeError):
    pass


_token_cache: dict = {"token": None, "exp": 0.0}


def _client_credentials_token() -> str:
    cid = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
    secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
    if not cid or not secret:
        raise SpotifyNotConfiguredError(
            "Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the server."
        )
    now = time()
    if _token_cache["token"] and _token_cache["exp"] > now + 60:
        return _token_cache["token"]
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SpotifyUpstreamError("Spotify token request failed.") from e
    except Exception as e:
        raise SpotifyUpstreamError("Spotify token request failed.") from e
    token = body.get("access_token")
    expires_in = int(body.get("expires_in", 3600))
    if not token:
        raise SpotifyUpstreamError("Spotify token response invalid.")
    _token_cache["token"] = token
    _token_cache["exp"] = now + float(expires_in)
    return token


def search_tracks_normalized(q: str, limit: int = 20) -> list[dict]:
    """Return the same shape as the former /api/spotify/search handler."""
    raw = (q or "").strip()
    if not raw:
        return []
    limit = max(1, min(50, int(limit)))
    token = _client_credentials_token()
    params = urllib.parse.urlencode(
        {"q": raw, "type": "track", "limit": str(limit), "market": _spotify_market()}
    )
    url = f"https://api.spotify.com/v1/search?{params}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SpotifyUpstreamError("Spotify search failed.") from e
    except Exception as e:
        raise SpotifyUpstreamError("Spotify search failed.") from e

    tracks_obj = data.get("tracks") or {}
    if not isinstance(tracks_obj, dict):
        tracks_obj = {}
    items = tracks_obj.get("items") or []
    out: list[dict] = []
    for t in items:
        if not isinstance(t, dict):
            continue
        album = t.get("album") or {}
        imgs = album.get("images") or []
        first_img = imgs[0] if imgs else {}
        image_url = first_img.get("url", "") if isinstance(first_img, dict) else ""
        artists = t.get("artists") or []
        ext = t.get("external_urls") if isinstance(t.get("external_urls"), dict) else {}
        open_url = (ext.get("spotify") or "").strip()
        out.append(
            {
                "name": t.get("name") or "",
                "uri": t.get("uri") or "",
                "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                "imageUrl": image_url,
                "preview_url": t.get("preview_url") or "",
                "open_url": open_url,
            }
        )
    return out


def search_albums_normalized(q: str, limit: int = 20) -> list[dict]:
    """Album search (client credentials); shape matches catalog album entries (no ``kind``)."""
    raw = (q or "").strip()
    if not raw:
        return []
    limit = max(1, min(50, int(limit)))
    token = _client_credentials_token()
    data_al = _spotify_search_one_type(token, raw, "album", limit)
    albums_obj = data_al.get("albums") or {}
    out: list[dict] = []
    if not isinstance(albums_obj, dict):
        return out
    for al in albums_obj.get("items") or []:
        if not isinstance(al, dict):
            continue
        artists = al.get("artists") or []
        artist_names = ", ".join(
            a.get("name", "") for a in artists if isinstance(a, dict) and a.get("name")
        )
        album_name = al.get("name") or ""
        # Field-filter queries (``album:… artist:…``) are already scoped; haystack would reject them.
        if ":" not in raw and not _query_matches_haystack(raw, album_name, artist_names):
            continue
        ext = al.get("external_urls") if isinstance(al.get("external_urls"), dict) else {}
        open_url = (ext.get("spotify") or "").strip()
        out.append(
            {
                "name": album_name,
                "uri": al.get("uri") or "",
                "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                "imageUrl": _first_image_url(al),
                "preview_url": "",
                "open_url": open_url,
            }
        )
    return out


def _first_image_url(obj: dict) -> str:
    imgs = obj.get("images") or []
    first = imgs[0] if imgs and isinstance(imgs[0], dict) else {}
    return (first.get("url") or "").strip() if isinstance(first, dict) else ""


def _spotify_market() -> str:
    """ISO 3166-1 alpha-2; search relevance is poor without ``market`` (override via SPOTIFY_MARKET)."""
    m = os.environ.get("SPOTIFY_MARKET", "US").strip().upper()
    if len(m) == 2 and m.isalpha():
        return m
    return "US"


def _norm_text(s: str) -> str:
    return " ".join((s or "").lower().split())


def _query_matches_haystack(q_raw: str, *parts: str) -> bool:
    """Require query substring in some field (drops unrelated Spotify rows when market is broad)."""
    q = _norm_text(q_raw)
    if len(q) < 2:
        return True
    hay = _norm_text(" ".join(parts))
    return q in hay


def _spotify_search_one_type(token: str, q: str, type_name: str, limit: int) -> dict:
    """Single-type GET /v1/search."""
    params = urllib.parse.urlencode(
        {
            "q": q,
            "type": type_name,
            "limit": str(limit),
            "market": _spotify_market(),
        }
    )
    url = f"https://api.spotify.com/v1/search?{params}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SpotifyUpstreamError("Spotify search failed.") from e
    except Exception as e:
        raise SpotifyUpstreamError("Spotify search failed.") from e


def search_catalog_normalized(q: str, limit_per_type: int = 50) -> list[dict]:
    """Search tracks, albums, and artists (one request per type; ``limit`` per type, max 50)."""
    raw = (q or "").strip()
    if not raw:
        return []
    limit_per_type = max(1, min(50, int(limit_per_type)))
    token = _client_credentials_token()

    artists_out: list[dict] = []
    albums_out: list[dict] = []
    tracks_out: list[dict] = []

    data_ar = _spotify_search_one_type(token, raw, "artist", limit_per_type)
    artists_obj = data_ar.get("artists") or {}
    if isinstance(artists_obj, dict):
        for ar in artists_obj.get("items") or []:
            if not isinstance(ar, dict):
                continue
            aname = ar.get("name") or ""
            if not _query_matches_haystack(raw, aname):
                continue
            ext = ar.get("external_urls") if isinstance(ar.get("external_urls"), dict) else {}
            open_url = (ext.get("spotify") or "").strip()
            artists_out.append(
                {
                    "kind": "artist",
                    "name": aname,
                    "uri": ar.get("uri") or "",
                    "artists": [],
                    "imageUrl": _first_image_url(ar),
                    "preview_url": "",
                    "open_url": open_url,
                    "subtitle": "Artist",
                }
            )

    data_al = _spotify_search_one_type(token, raw, "album", limit_per_type)
    albums_obj = data_al.get("albums") or {}
    if isinstance(albums_obj, dict):
        for al in albums_obj.get("items") or []:
            if not isinstance(al, dict):
                continue
            artists = al.get("artists") or []
            artist_names = ", ".join(
                a.get("name", "") for a in artists if isinstance(a, dict) and a.get("name")
            )
            album_name = al.get("name") or ""
            if not _query_matches_haystack(raw, album_name, artist_names):
                continue
            ext = al.get("external_urls") if isinstance(al.get("external_urls"), dict) else {}
            open_url = (ext.get("spotify") or "").strip()
            sub = f"Album · {artist_names}" if artist_names else "Album"
            albums_out.append(
                {
                    "kind": "album",
                    "name": album_name,
                    "uri": al.get("uri") or "",
                    "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                    "imageUrl": _first_image_url(al),
                    "preview_url": "",
                    "open_url": open_url,
                    "subtitle": sub,
                }
            )

    data_tr = _spotify_search_one_type(token, raw, "track", limit_per_type)
    tracks_obj = data_tr.get("tracks") or {}
    if isinstance(tracks_obj, dict):
        for t in tracks_obj.get("items") or []:
            if not isinstance(t, dict):
                continue
            album = t.get("album") if isinstance(t.get("album"), dict) else {}
            artists = t.get("artists") or []
            track_name = t.get("name") or ""
            imgs = album.get("images") or []
            first_img = imgs[0] if imgs else {}
            image_url = first_img.get("url", "") if isinstance(first_img, dict) else ""
            ext = t.get("external_urls") if isinstance(t.get("external_urls"), dict) else {}
            open_url = (ext.get("spotify") or "").strip()
            tracks_out.append(
                {
                    "kind": "track",
                    "name": track_name,
                    "uri": t.get("uri") or "",
                    "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                    "imageUrl": image_url,
                    "preview_url": t.get("preview_url") or "",
                    "open_url": open_url,
                }
            )

    merged: list[dict] = []
    for group in zip_longest(artists_out, albums_out, tracks_out, fillvalue=None):
        for item in group:
            if item is not None:
                merged.append(item)
    return merged


_SPOTIFY_ID_RE = re.compile(r"^[0-9A-Za-z]{10,32}$")


def _safe_spotify_catalog_id(raw: str) -> str:
    s = (raw or "").strip()
    if not _SPOTIFY_ID_RE.fullmatch(s):
        raise ValueError("Invalid Spotify id.")
    return s


def _spotify_api_get_json(token: str, url: str) -> dict:
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SpotifyUpstreamError("Spotify request failed.") from e
    except Exception as e:
        raise SpotifyUpstreamError("Spotify request failed.") from e


def album_tracks_normalized(album_id: str, limit: int = 50) -> list[dict]:
    """Client-credentials: album track list (simplified track objects)."""
    aid = _safe_spotify_catalog_id(album_id)
    limit = max(1, min(50, int(limit)))
    token = _client_credentials_token()
    market = _spotify_market()
    safe = urllib.parse.quote(aid, safe="")
    q = urllib.parse.urlencode({"limit": str(limit), "market": market})
    url = f"https://api.spotify.com/v1/albums/{safe}/tracks?{q}"
    data = _spotify_api_get_json(token, url)
    items = data.get("items") or []
    out: list[dict] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        artists = row.get("artists") or []
        ext = row.get("external_urls") if isinstance(row.get("external_urls"), dict) else {}
        open_url = (ext.get("spotify") or "").strip()
        tid = row.get("id") or ""
        uri = (row.get("uri") or "").strip() or (f"spotify:track:{tid}" if tid else "")
        out.append(
            {
                "name": row.get("name") or "",
                "uri": uri,
                "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                "imageUrl": "",
                "preview_url": row.get("preview_url") or "",
                "open_url": open_url,
            }
        )
    return out


def artist_top_tracks_normalized(artist_id: str) -> list[dict]:
    """Client-credentials: up to 10 top tracks for an artist (Spotify limit)."""
    arid = _safe_spotify_catalog_id(artist_id)
    token = _client_credentials_token()
    market = _spotify_market()
    safe = urllib.parse.quote(arid, safe="")
    q = urllib.parse.urlencode({"market": market})
    url = f"https://api.spotify.com/v1/artists/{safe}/top-tracks?{q}"
    data = _spotify_api_get_json(token, url)
    tracks = data.get("tracks") or []
    out: list[dict] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        album = t.get("album") if isinstance(t.get("album"), dict) else {}
        imgs = album.get("images") or []
        first_img = imgs[0] if imgs and isinstance(imgs[0], dict) else {}
        image_url = first_img.get("url", "") if isinstance(first_img, dict) else ""
        artists = t.get("artists") or []
        ext = t.get("external_urls") if isinstance(t.get("external_urls"), dict) else {}
        open_url = (ext.get("spotify") or "").strip()
        out.append(
            {
                "name": t.get("name") or "",
                "uri": (t.get("uri") or "").strip(),
                "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                "imageUrl": image_url,
                "preview_url": t.get("preview_url") or "",
                "open_url": open_url,
            }
        )
    return out


def artist_albums_normalized(artist_id: str, limit: int = 200) -> list[dict]:
    """Client-credentials: artist albums/singles for panel drill-in."""
    arid = _safe_spotify_catalog_id(artist_id)
    cap = max(1, min(200, int(limit)))
    token = _client_credentials_token()
    market = _spotify_market()
    safe = urllib.parse.quote(arid, safe="")
    q = urllib.parse.urlencode(
        {
            "include_groups": "album,single",
            "market": market,
            "limit": "50",
            "offset": "0",
        }
    )
    next_url = f"https://api.spotify.com/v1/artists/{safe}/albums?{q}"
    out: list[dict] = []
    seen_ids: set[str] = set()

    while next_url and len(out) < cap:
        data = _spotify_api_get_json(token, next_url)
        items = data.get("items") or []
        if not isinstance(items, list):
            break
        for row in items:
            if len(out) >= cap:
                break
            if not isinstance(row, dict):
                continue
            rid = (row.get("id") or "").strip()
            if rid and rid in seen_ids:
                continue
            if rid:
                seen_ids.add(rid)
            artists = row.get("artists") or []
            artist_names = ", ".join(
                a.get("name", "") for a in artists if isinstance(a, dict) and a.get("name")
            )
            ext = row.get("external_urls") if isinstance(row.get("external_urls"), dict) else {}
            open_url = (ext.get("spotify") or "").strip()
            uri = (row.get("uri") or "").strip() or (f"spotify:album:{rid}" if rid else "")
            out.append(
                {
                    "name": row.get("name") or "",
                    "uri": uri,
                    "artists": [{"name": a.get("name", "")} for a in artists if isinstance(a, dict)],
                    "imageUrl": _first_image_url(row),
                    "preview_url": "",
                    "open_url": open_url,
                    "subtitle": f"Album · {artist_names}" if artist_names else "Album",
                }
            )
        n = data.get("next")
        next_url = n if isinstance(n, str) and n.strip() else ""
    return out
