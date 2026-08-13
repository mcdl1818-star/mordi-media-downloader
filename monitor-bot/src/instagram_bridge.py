#!/usr/bin/env python3
import json
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5


def output(value, code=0):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def text_url(value):
    return str(value) if value else ""


def iso_time(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value or "")


def configure_stable_client(client, seed):
    if len(seed) < 32:
        output({"status": "ERROR", "message": "Missing stable device seed"}, 2)
    stable = lambda label: str(uuid5(NAMESPACE_URL, f"mordi-instagram:{seed}:{label}"))
    client.set_uuids({
        "phone_id": stable("phone_id"),
        "uuid": stable("uuid"),
        "client_session_id": stable("client_session_id"),
        "advertising_id": stable("advertising_id"),
        "android_device_id": "android-" + hashlib.sha256(f"{seed}:android".encode()).hexdigest()[:16],
        "request_id": stable("request_id"),
        "tray_session_id": stable("tray_session_id"),
    })
    client.set_country("IL")
    client.set_country_code(972)
    client.set_locale("he_IL")
    client.set_timezone_offset(10800, "Asia/Jerusalem")


def login():
    from instagrapi import Client
    client = None

    def result(status, **extra):
        value = {"status": status, **extra}
        if client is not None and status != "OK":
            try:
                value["settings"] = client.get_settings()
            except Exception:
                pass
        output(value)

    try:
        payload = json.load(sys.stdin)
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        code = str(payload.get("code", "")).strip()
        if not username or not password:
            output({"status": "ERROR", "message": "חסרים שם משתמש או סיסמה"}, 2)
        saved_settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else None
        client = Client(settings=saved_settings or {})
        if not saved_settings:
            seed = str(payload.get("deviceSeed", "")).strip()
            configure_stable_client(client, seed)
        client.delay_range = [1, 3]
        if code:
            client.challenge_code_handler = lambda _username, _choice: code
        logged_in = client.login(username, password, verification_code=code)
        settings = client.get_settings()
        session_id = str(settings.get("authorization_data", {}).get("sessionid", ""))
        if not logged_in or not session_id:
            result("LOGIN_REJECTED")
        output({"status": "OK", "username": username, "session": settings})
    except Exception as error:
        root_error = error
        if type(error).__name__ == "RetryError" and hasattr(error, "last_attempt"):
            try:
                root_error = error.last_attempt.exception() or error
            except Exception:
                root_error = error
        name = type(root_error).__name__
        last_json = client.last_json if client is not None and isinstance(getattr(client, "last_json", None), dict) else {}
        signals = " ".join(str(value) for value in (
            error,
            last_json.get("message", ""),
            last_json.get("error_type", ""),
            last_json.get("feedback_title", ""),
            last_json.get("feedback_message", ""),
            last_json.get("checkpoint_url", ""),
        )).lower()
        if name in ("TwoFactorRequired", "TwoFactorAuthRequired") or "two_factor" in signals:
            result("TWO_FACTOR", reason=name)
        if name in ("ChallengeRequired", "ChallengeUnknownStep", "ClientNotFoundError") or any(value in signals for value in ("challenge_required", "checkpoint_required", "verification_required")):
            result("CHALLENGE", reason=name)
        if name in ("BadCredentials", "BadPassword", "InvalidUser") or any(value in signals for value in ("bad_password", "invalid_user", "invalid_credentials")):
            result("BAD_CREDENTIALS", reason=name)
        if name in ("PleaseWaitFewMinutes", "ClientThrottledError", "RateLimitError") or any(value in signals for value in ("please wait", "rate_limit", "too many requests")):
            result("RATE_LIMIT", reason=name)
        if name in ("SentryBlock", "FeedbackRequired", "LoginRequired", "ClientLoginRequired", "ReloginAttemptExceeded", "ProxyAddressIsBlocked") or any(value in signals for value in ("sentry_block", "feedback_required", "login_required", "proxy_address_is_blocked")):
            result("LOGIN_BLOCKED", reason=name)
        if name in ("ClientConnectionError", "ClientJSONDecodeError", "ClientProxyConnectionError", "ConnectTimeout", "ReadTimeout"):
            result("NETWORK_ERROR", reason=name)
        result("LOGIN_REJECTED", reason=name)


def import_session():
    from instagrapi import Client
    try:
        payload = json.load(sys.stdin)
        session_id = str(payload.get("sessionid", "")).strip()
        username = str(payload.get("username", "")).strip()
        saved_settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else None
        if len(session_id) < 20 or not username:
            output({"status": "INVALID_SESSION"})
        client = Client(settings=saved_settings or {})
        if not saved_settings:
            configure_stable_client(client, str(payload.get("deviceSeed", "")).strip())
        client.delay_range = [1, 3]
        if not client.login_by_sessionid(session_id):
            output({"status": "WEB_SESSION_ONLY"})
        settings = client.get_settings()
        if not str(settings.get("authorization_data", {}).get("sessionid", "")):
            output({"status": "WEB_SESSION_ONLY"})
        output({"status": "OK", "username": username, "session": settings})
    except Exception as error:
        output({"status": "WEB_SESSION_ONLY", "reason": type(error).__name__})


def media_parts(media, username, kind):
    resources = list(getattr(media, "resources", None) or []) or [media]
    shortcode = str(getattr(media, "code", "") or getattr(media, "pk", ""))
    post_url = (f"https://www.instagram.com/reel/{shortcode}/"
                if kind == "reel" else f"https://www.instagram.com/p/{shortcode}/")
    caption = str(getattr(media, "caption_text", "") or "פרסום חדש")
    taken_at = iso_time(getattr(media, "taken_at", None))
    items = []
    for resource in resources:
        media_id = str(getattr(resource, "pk", "") or getattr(media, "pk", ""))
        video = text_url(getattr(resource, "video_url", None) or getattr(media, "video_url", None))
        photo = text_url(getattr(resource, "thumbnail_url", None) or getattr(media, "thumbnail_url", None))
        if not media_id or not (video or photo):
            continue
        items.append({
            "media_id": media_id,
            "post_id": str(getattr(media, "pk", media_id)),
            "post_shortcode": shortcode,
            "post_url": post_url,
            "username": username,
            "date": taken_at,
            "description": caption,
            "type": kind,
            "video_url": video or None,
            "display_url": photo or None,
        })
    return items


def story_item(story, username):
    media_id = str(getattr(story, "pk", ""))
    video = text_url(getattr(story, "video_url", None))
    photo = text_url(getattr(story, "thumbnail_url", None))
    if not media_id or not (video or photo):
        return None
    return {
        "media_id": media_id,
        "post_id": media_id,
        "post_shortcode": media_id,
        "post_url": f"https://www.instagram.com/stories/{username}/{media_id}/",
        "username": username,
        "date": iso_time(getattr(story, "taken_at", None)),
        "expires": iso_time(getattr(story, "taken_at", None)),
        "description": "סטורי חדש",
        "type": "story",
        "video_url": video or None,
        "display_url": photo or None,
    }


def scan():
    from instagrapi import Client
    if len(sys.argv) != 5 or sys.argv[2] != "--session":
        output({"status": "ERROR", "message": "Invalid scan arguments"}, 2)
    session_file = Path(sys.argv[3])
    username = sys.argv[4].strip().lstrip("@")
    limit = max(3, min(50, int(sys.stdin.read().strip() or "15")))
    try:
        settings = json.loads(session_file.read_text(encoding="utf-8"))
        client = Client(settings=settings)
        client.delay_range = [2, 4]
        user_id = client.user_id_from_username(username)
        media = list(client.user_medias(user_id, amount=limit))
        items = []
        seen = set()
        for entry in media:
            kind = "reel" if str(getattr(entry, "product_type", "")) == "clips" else "post"
            for item in media_parts(entry, username, kind):
                if item["media_id"] not in seen:
                    seen.add(item["media_id"])
                    items.append(item)
        try:
            for story in client.user_stories(user_id):
                item = story_item(story, username)
                if item and item["media_id"] not in seen:
                    seen.add(item["media_id"])
                    items.append(item)
        except Exception:
            pass
        items.sort(key=lambda item: item.get("date", ""), reverse=True)
        output({"status": "OK", "items": items[:limit], "settings": client.get_settings()})
    except Exception as error:
        name = type(error).__name__
        if name in ("LoginRequired", "ClientLoginRequired", "AuthRequired"):
            output({"status": "SESSION_EXPIRED"})
        if name in ("RetryError", "PleaseWaitFewMinutes", "ClientThrottledError", "RateLimitError"):
            output({"status": "RATE_LIMIT", "message": "Instagram temporarily rate-limited the scan"}, 2)
        if name in ("ClientConnectionError", "ClientJSONDecodeError", "ClientProxyConnectionError", "ConnectTimeout", "ReadTimeout"):
            output({"status": "NETWORK_ERROR", "message": "Instagram scan had a temporary network error"}, 2)
        output({"status": "ERROR", "message": f"Instagram scan failed ({name})"}, 2)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        output({"status": "ERROR", "message": "Missing command"}, 2)
    if sys.argv[1] == "login":
        login()
    if sys.argv[1] == "import-session":
        import_session()
    if sys.argv[1] == "scan":
        scan()
    output({"status": "ERROR", "message": "Unknown command"}, 2)
