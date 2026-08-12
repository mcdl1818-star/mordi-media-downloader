#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


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


def login():
    from instagrapi import Client
    try:
        payload = json.load(sys.stdin)
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        code = str(payload.get("code", "")).strip()
        if not username or not password:
            output({"status": "ERROR", "message": "חסרים שם משתמש או סיסמה"}, 2)
        client = Client()
        client.delay_range = [1, 3]
        client.login(username, password, verification_code=code)
        client.account_info()
        output({"status": "OK", "username": username, "session": client.get_settings()})
    except Exception as error:
        name = type(error).__name__
        if name in ("TwoFactorRequired", "TwoFactorAuthRequired"):
            output({"status": "TWO_FACTOR"})
        if name in ("ChallengeRequired", "ChallengeUnknownStep"):
            output({"status": "CHALLENGE"})
        if name in ("BadPassword", "InvalidUser"):
            output({"status": "BAD_CREDENTIALS"})
        output({"status": "ERROR", "message": "Instagram דחתה את ההתחברות. נסה שוב או אשר את הכניסה באפליקציה."}, 2)


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
        client.delay_range = [1, 3]
        user_id = client.user_id_from_username(username)
        media = list(client.user_medias(user_id, amount=limit))
        try:
            media.extend(client.user_clips(user_id, amount=limit))
        except Exception:
            pass
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
        output({"status": "OK", "items": items[:limit]})
    except Exception as error:
        name = type(error).__name__
        if name in ("LoginRequired", "ClientLoginRequired", "AuthRequired"):
            output({"status": "SESSION_EXPIRED"})
        output({"status": "ERROR", "message": "Instagram scan failed"}, 2)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        output({"status": "ERROR", "message": "Missing command"}, 2)
    if sys.argv[1] == "login":
        login()
    if sys.argv[1] == "scan":
        scan()
    output({"status": "ERROR", "message": "Unknown command"}, 2)
