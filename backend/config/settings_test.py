"""Settings for the automated test-suite (pytest). Uses the same PostgreSQL engine as production."""
import os

os.environ.setdefault("DJANGO_DEBUG", "1")
os.environ.setdefault("THROTTLE_AUTH", "1000/minute")
os.environ.setdefault("THROTTLE_PASSWORD_RESET", "1000/minute")
os.environ.setdefault("THROTTLE_REFRESH", "1000/minute")
os.environ.setdefault("LOG_LEVEL", "WARNING")

from .settings import *  # noqa: E402,F401,F403

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
MEDIA_ROOT = BASE_DIR / "test-media"  # noqa: F405
