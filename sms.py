"""SMS delivery for guest sign-in codes and order notifications.

A provider is selected with `SMS_PROVIDER` and configured with that provider's environment variables.
Nothing is ever reported as sent unless the provider accepted the message.

    SMS_PROVIDER=twilio          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)
    SMS_PROVIDER=africastalking  AT_USERNAME, AT_API_KEY, AT_FROM (optional sender id)
    SMS_PROVIDER=afromessage     AFROMESSAGE_TOKEN, AFROMESSAGE_SENDER (sender name, default "Afropay"), AFROMESSAGE_CALLBACK (optional),
                                 AFROMESSAGE_CHALLENGE=1 to let AfroMessage generate sign-in codes with its
                                 challenge endpoint. `from` is never sent: the token identifies the account.
    SMS_PROVIDER=geezsms         GEEZSMS_TOKEN, GEEZSMS_FROM (optional sender id)
    SMS_PROVIDER=http            SMS_HTTP_URL, SMS_HTTP_METHOD (POST), SMS_HTTP_AUTH (header value),
                                 SMS_HTTP_BODY (JSON template with {phone} and {text}), SMS_HTTP_CONTENT_TYPE
    SMS_PROVIDER=console         Development only: the message is printed, never delivered. Refused in production.

Every request and reply is logged. The message text, the sign-in code and the guest's number are hidden;
set SMS_DEBUG=1 to log them in full while troubleshooting, then turn it off.

`http` is the safe choice for a gateway not listed here: it posts whatever body template you configure.
Confirm the endpoint and field names against your provider's current documentation, then check delivery with:

    SMS_PROVIDER=… python3 server.py --sms-test +251911234567
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 15
# Gateways behind Cloudflare reject the default urllib agent with "error code: 1010".
USER_AGENT = os.environ.get('SMS_USER_AGENT') or 'Mozilla/5.0 (compatible; Encore/1.0; +https://github.com/birukhios/encore)'


class NotConfigured(Exception):
    """Raised when no SMS provider can deliver messages in this environment."""


class DeliveryFailed(Exception):
    """Raised when the configured provider rejected or failed to accept a message."""


SECRET_FIELDS = ('message', 'msg', 'text', 'Body', 'pr', 'ps', 'token')


def debug():
    """SMS_DEBUG=1 logs requests and replies in full, including the sign-in code. Use it briefly, then turn it off."""
    return os.environ.get('SMS_DEBUG', '').strip().lower() in ('1', 'true', 'yes', 'on')


def _log(line):
    print(f'SMS {line}', file=sys.stderr, flush=True)


def mask_phone(value):
    value = str(value)
    return value[:5] + '*' * max(0, len(value) - 9) + value[-4:] if len(value) > 9 else '***'


def safe_url(url):
    """The query carries the message (and therefore the code) and the guest's number: hide both."""
    if debug():
        return url
    head, _, query = url.partition('?')
    if not query:
        return url
    parts = []
    for key, value in urllib.parse.parse_qsl(query, keep_blank_values=True):
        if key in SECRET_FIELDS:
            value = f'<{len(value)} chars hidden>'
        elif key in ('to', 'phone', 'To'):
            value = mask_phone(value)
        parts.append(f'{key}={value}')
    return head + '?' + '&'.join(parts)


def safe_body(body):
    """Keep the gateway's status and errors; hide any code it generated."""
    if debug():
        return body
    text = re.sub(r'("(?:code|pin|otp)"\s*:\s*")[^"]*(")', r'\1***\2', body or '')
    return text[:400]


def _request(url, data=None, headers=None, method='POST'):
    """Send one HTTP request and return the decoded body, or raise DeliveryFailed with the provider's reason.

    Both directions are logged so operators can see exactly what the gateway was asked and what it answered.
    """
    headers = {'User-Agent': USER_AGENT, 'Accept': 'application/json', **(headers or {})}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    payload = (data or b'').decode('utf-8', 'replace')
    _log(f'-> {method} {safe_url(url)}' + (f' body={safe_body(payload)}' if payload else ''))
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read().decode('utf-8', 'replace')
        _log(f'<- {response.status} {safe_body(body)}')
        if not 200 <= response.status < 300:
            raise DeliveryFailed(f'{response.status}: {body[:200]}')
        return body
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'replace')[:400] if exc.fp else ''
        _log(f'<- {exc.code} {safe_body(detail)}')
        raise DeliveryFailed(f'{exc.code}: {detail[:200]}') from exc
    except urllib.error.URLError as exc:
        _log(f'<- no reply: {exc.reason}')
        raise DeliveryFailed(f'could not reach the SMS provider: {exc.reason}') from exc


def _form(url, fields, headers=None):
    head = {'Content-Type': 'application/x-www-form-urlencoded', **(headers or {})}
    return _request(url, urllib.parse.urlencode(fields).encode(), head)


def _json_post(url, payload, headers=None):
    head = {'Content-Type': 'application/json', **(headers or {})}
    return _request(url, json.dumps(payload).encode(), head)


def _get(url, params, headers=None):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, '')})
    head = {'Content-Type': 'application/json', **(headers or {})}
    return _request(f'{url}?{query}', None, head, 'GET')


def _env(*names):
    return [os.environ.get(name, '').strip() for name in names]


# ---------------------------------------------------------------- providers

def _send_twilio(phone, text):
    sid, token, sender, service = _env('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID')
    fields = {'To': phone, 'Body': text}
    fields.update({'MessagingServiceSid': service} if service else {'From': sender})
    auth = base64.b64encode(f'{sid}:{token}'.encode()).decode()
    _form(f'https://api.twilio.com/2010-04-01/Accounts/{urllib.parse.quote(sid)}/Messages.json', fields,
          {'Authorization': 'Basic ' + auth})


def _twilio_missing():
    sid, token, sender, service = _env('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID')
    missing = [n for n, v in [('TWILIO_ACCOUNT_SID', sid), ('TWILIO_AUTH_TOKEN', token)] if not v]
    return missing + ([] if sender or service else ['TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID'])


def _send_africastalking(phone, text):
    username, key, sender = _env('AT_USERNAME', 'AT_API_KEY', 'AT_FROM')
    fields = {'username': username, 'to': phone, 'message': text}
    if sender:
        fields['from'] = sender
    host = 'api.sandbox.africastalking.com' if username == 'sandbox' else 'api.africastalking.com'
    _form(f'https://{host}/version1/messaging', fields, {'apiKey': key, 'Accept': 'application/json'})


AFROMESSAGE_API = 'https://api.afromessage.com/api'


AFROMESSAGE_DEFAULT_SENDER = 'Afropay'


def _afromessage_auth():
    """AfroMessage identifies the account from the token; `from` is not sent."""
    token, sender, callback = _env('AFROMESSAGE_TOKEN', 'AFROMESSAGE_SENDER', 'AFROMESSAGE_CALLBACK')
    return {'Authorization': 'Bearer ' + token}, {'sender': sender or AFROMESSAGE_DEFAULT_SENDER, 'callback': callback}


def _afromessage_result(body):
    """AfroMessage answers 200 for failures too: only `acknowledge: success` means the message was accepted."""
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        raise DeliveryFailed(f'unexpected reply from AfroMessage: {body[:200]}')
    if not isinstance(data, dict) or str(data.get('acknowledge', '')).lower() != 'success':
        detail = data.get('response') if isinstance(data, dict) else None
        raise DeliveryFailed(str(detail or data.get('message') if isinstance(data, dict) else body)[:200])
    return data.get('response') or {}


def _send_afromessage(phone, text):
    headers, base = _afromessage_auth()
    _afromessage_result(_get(f'{AFROMESSAGE_API}/send', {**base, 'to': phone, 'message': text}, headers))


def _afromessage_challenge(phone, ttl, length):
    """Ask AfroMessage to generate and send a code (/api/challenge).

    The reply carries the code and a verificationId; Encore keeps the id and later asks /api/verify,
    so the code itself is never stored.
    """
    headers, base = _afromessage_auth()
    prefix, postfix, code_type = _env('AFROMESSAGE_PREFIX', 'AFROMESSAGE_POSTFIX', 'AFROMESSAGE_CODE_TYPE')
    params = {**base, 'to': phone, 'len': length, 'ttl': ttl, 't': code_type or 0, 'sb': 1, 'sa': 1,
              'pr': prefix or 'Your Afropay code is', 'ps': postfix or '. It expires in 5 minutes. Never share this code.'}
    result = _afromessage_result(_get(f'{AFROMESSAGE_API}/challenge', params, headers))
    verification = str(result.get('verificationId') or '').strip()
    code = str(result.get('code') or '').strip()
    if not verification and not code:
        raise DeliveryFailed('AfroMessage returned neither a verification id nor a code, so the sign-in cannot be checked.')
    return code, verification


def _afromessage_verify(phone, code, verification_id):
    """Ask AfroMessage whether this code is the one it sent (/api/verify). False means wrong or expired."""
    headers, _ = _afromessage_auth()
    params = {'to': phone, 'code': code}
    if verification_id:
        params['vc'] = verification_id
    try:
        _afromessage_result(_get(f'{AFROMESSAGE_API}/verify', params, headers))
        return True
    except DeliveryFailed as exc:
        _log(f'verify rejected for {mask_phone(phone)}: {exc}')
        return False


def afromessage_balance():
    """Remaining credit for the account behind the token (/api/balance)."""
    headers, _ = _afromessage_auth()
    return _afromessage_result(_get(f'{AFROMESSAGE_API}/balance', {}, headers))


def _send_geezsms(phone, text):
    token, sender = _env('GEEZSMS_TOKEN', 'GEEZSMS_FROM')
    payload = {'token': token, 'phone': phone, 'msg': text}
    if sender:
        payload['shortcode_id'] = sender
    body = _json_post('https://api.geezsms.com/api/v1/sms/send', payload)
    _reject_error_body(body)


def _send_http(phone, text):
    """Generic gateway: posts a configured body template. Use for providers not built in."""
    url, method, auth, template, content_type = _env('SMS_HTTP_URL', 'SMS_HTTP_METHOD', 'SMS_HTTP_AUTH', 'SMS_HTTP_BODY', 'SMS_HTTP_CONTENT_TYPE')
    template = template or '{"to": "{phone}", "text": "{text}"}'
    body = template.replace('{phone}', phone).replace('{text}', json.dumps(text)[1:-1])
    headers = {'Content-Type': content_type or 'application/json'}
    if auth:
        headers['Authorization'] = auth
    _reject_error_body(_request(url, body.encode(), headers, method or 'POST'))


def _reject_error_body(body):
    """Some gateways answer 200 with an error payload; treat a declared failure as a failure."""
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return
    if not isinstance(data, dict):
        return
    status = str(data.get('acknowledge') or data.get('status') or data.get('result') or '').lower()
    if status in ('error', 'failed', 'failure', 'false') or data.get('error') or data.get('errors'):
        raise DeliveryFailed(str(data.get('response') or data.get('message') or data.get('error') or body)[:200])


PROVIDERS = {
    'twilio': _send_twilio,
    'africastalking': _send_africastalking,
    'afromessage': _send_afromessage,
    'geezsms': _send_geezsms,
    'http': _send_http,
}
REQUIRED = {
    'twilio': _twilio_missing,
    'africastalking': lambda: [n for n in ('AT_USERNAME', 'AT_API_KEY') if not os.environ.get(n)],
    'afromessage': lambda: [n for n in ('AFROMESSAGE_TOKEN',) if not os.environ.get(n)],
    'geezsms': lambda: [n for n in ('GEEZSMS_TOKEN',) if not os.environ.get(n)],
    'http': lambda: [n for n in ('SMS_HTTP_URL',) if not os.environ.get(n)],
}


# ---------------------------------------------------------------- interface

def provider_name():
    return os.environ.get('SMS_PROVIDER', '').strip().lower()


def production():
    return os.environ.get('ENCORE_ENV') == 'production'


def missing_settings():
    """Environment variables the chosen provider still needs."""
    name = provider_name()
    return REQUIRED.get(name, lambda: [])() if name in PROVIDERS else []


def status():
    """Human-readable delivery status for the admin settings screen and the production check."""
    name = provider_name()
    if name in PROVIDERS:
        missing = missing_settings()
        if missing:
            return {'provider': name, 'delivers': False, 'label': f'{name}: set {", ".join(missing)}'}
        return {'provider': name, 'delivers': True, 'label': f'Connected ({name})'}
    if not production() and name in ('', 'console'):
        return {'provider': 'console', 'delivers': False,
                'label': 'Development mode: codes are printed in the server terminal, not sent'}
    return {'provider': name or None, 'delivers': False,
            'label': 'Not configured — set SMS_PROVIDER and its credentials'}


def flag(name):
    return os.environ.get(name, '').strip().lower() in ('1', 'true', 'yes', 'on')


def send_signin_code(phone, code, ttl, length=6):
    """Deliver a sign-in code. Returns (code, verification_id).

    Normally Encore's own code is sent and verified locally, so `verification_id` is empty.
    With AfroMessage's challenge endpoint the gateway generates the code and verifies it later,
    so a verification id comes back and the code itself never needs to be stored.
    """
    if provider_name() == 'afromessage' and flag('AFROMESSAGE_CHALLENGE'):
        missing = missing_settings()
        if missing:
            raise NotConfigured(f'afromessage is missing {", ".join(missing)}.')
        return _afromessage_challenge(phone, ttl, length)
    send(phone, f'Your Afropay code is {code}. It expires in {ttl // 60} minutes. Never share this code.')
    return code, ''


def verify_signin_code(phone, code, verification_id):
    """Check a code with the provider that issued it. Only used when the provider generated it."""
    if provider_name() == 'afromessage':
        return _afromessage_verify(phone, code, verification_id)
    raise NotConfigured('This provider cannot verify codes.')


def send(phone, text):
    """Deliver one message. Raises NotConfigured or DeliveryFailed; returns the provider name on success."""
    name = provider_name()
    if name in PROVIDERS:
        missing = missing_settings()
        if missing:
            raise NotConfigured(f'{name} is missing {", ".join(missing)}.')
        PROVIDERS[name](phone, text)
        return name
    if not production() and name in ('', 'console'):
        print(f'[DEV SMS - NOT DELIVERED] to {phone}: {text}', file=sys.stdout, flush=True)
        return 'console'
    raise NotConfigured('SMS delivery is not configured.')
