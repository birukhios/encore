"""Smoke-check the .NET relay against disposable local Python and PostgreSQL services."""
import http.cookiejar
import json
import os
import secrets
import urllib.error
import urllib.request


BASE = os.environ.get('ENCORE_BRIDGE_URL', 'http://127.0.0.1:8080')
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(path, data=None):
    raw = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, raw, {'Content-Type': 'application/json'} if raw else {})
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def main():
    status, health = request('/bridge/health')
    assert status == 200 and health['ok']
    status, admin_health = request('/admin/api/health')
    assert status == 200 and admin_health['app'] == 'admin'
    status, guest_health = request('/api/health')
    assert status == 200 and guest_health['app'] == 'guest'

    email = 'relay-' + secrets.token_hex(5) + '@example.test'
    status, created = request('/admin/api/signup', {
        'team': 'Relay Test', 'name': 'Test Owner', 'email': email,
        'password': secrets.token_urlsafe(20),
    })
    assert status == 201, (status, created.get('error'))
    tenant = created['user']['tenant']
    assert created['state']['currency'] == 'ETB'
    status, me = request('/admin/api/me')
    assert status == 200 and me['user']['tenant'] == tenant
    status, workspaces = request('/api/workspaces')
    assert status == 200 and any(workspace['id'] == tenant for workspace in workspaces)
    status, public = request('/api/public?tenant=' + tenant)
    assert status == 200 and public['id'] == tenant
    status, payment = request('/api/checkout', {'tenant': tenant})
    assert status == 503 and payment['code'] == 'PAYMENT_NOT_CONFIGURED'
    status, signed_out = request('/admin/api/signout', {})
    assert status == 200 and signed_out['ok']
    status, _ = request('/admin/api/me')
    assert status == 401
    print('Relay signup, session, tenant, checkout rejection and signout: PASS')


if __name__ == '__main__':
    main()
