"""SMS delivery for guest one-time codes and notifications.

No real provider is wired up yet. The provider is chosen with SMS_PROVIDER:

  (unset) or "console"  Development only. Messages are printed to the server terminal and
                        NOT delivered. Refused when ENCORE_ENV=production.

To add a real provider, implement a `_send_<name>(phone, text)` function against that
provider's documented API, read its credentials from environment variables, and register it
in PROVIDERS. Never report a message as sent unless the provider accepted it.
"""
import os
import sys


class NotConfigured(Exception):
    """Raised when no SMS provider can deliver messages in this environment."""


class DeliveryFailed(Exception):
    """Raised when the configured provider rejected or failed to accept a message."""


PROVIDERS = {}  # name -> callable(phone, text); real providers are registered here.


def demo_log_allowed():
    """Hosted test deployments may opt in to writing codes to server logs instead of sending SMS."""
    return provider_name() == 'log' and os.environ.get('ENCORE_ALLOW_LOG_SMS') == '1'


def provider_name():
    return os.environ.get('SMS_PROVIDER', '').strip().lower()


def production():
    return os.environ.get('ENCORE_ENV') == 'production'


def status():
    """Human-readable delivery status for the admin settings screen."""
    name = provider_name()
    if name in PROVIDERS:
        return {'provider': name, 'delivers': True, 'label': 'Connected'}
    if not production() and name in ('', 'console'):
        return {'provider': 'console', 'delivers': False,
                'label': 'Development mode: codes are printed in the server terminal, not sent'}
    if demo_log_allowed():
        return {'provider': 'log', 'delivers': False,
                'label': 'Demo mode: codes are written to the server logs, not sent. Do not use with real guests'}
    return {'provider': name or None, 'delivers': False, 'label': 'Not configured'}


def send(phone, text):
    name = provider_name()
    if name in PROVIDERS:
        try:
            PROVIDERS[name](phone, text)
        except Exception as exc:  # provider-specific failures are reported uniformly
            raise DeliveryFailed(str(exc)) from exc
        return name
    if (not production() and name in ('', 'console')) or demo_log_allowed():
        print(f'[DEV SMS - NOT DELIVERED] to {phone}: {text}', file=sys.stdout, flush=True)
        return 'console'
    raise NotConfigured('SMS delivery is not configured.')
