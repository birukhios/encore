"""Encore application server. Python 3.11+, SQLite. Read README before deployment.

Two listeners share one database:
  admin app  PORT        (default 8081)  organizer accounts, workspace management
  guest app  GUEST_PORT  (default 8082)  phone-number guests, bookings, table ordering
Each listener serves only its own web app and API routes.
"""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import db
import domain
import sms
from domain import text, email, uid

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('ENCORE_DATA', ROOT / 'data'))
UPLOADS = DATA / 'uploads'
DB = DATA / 'encore.sqlite3'
PROD = os.environ.get('ENCORE_ENV') == 'production'
ADMIN_PORT = int(os.environ.get('PORT', '8081'))
GUEST_PORT = int(os.environ.get('GUEST_PORT', '8082'))
# Single-port mode (hosts such as Render expose one port): guest app at /, organizer admin at /admin.
SINGLE_PORT = os.environ.get('ENCORE_SINGLE_PORT') == '1'
_PUBLIC = (os.environ.get('PUBLIC_ORIGIN') or os.environ.get('RENDER_EXTERNAL_URL') or '').rstrip('/')
if SINGLE_PORT:
    _PUBLIC = _PUBLIC or f'http://127.0.0.1:{ADMIN_PORT}'
    ADMIN_ORIGIN = GUEST_ORIGIN = _PUBLIC
else:
    ADMIN_ORIGIN = (os.environ.get('ADMIN_ORIGIN') or _PUBLIC or f'http://127.0.0.1:{ADMIN_PORT}').rstrip('/')
    GUEST_ORIGIN = (os.environ.get('GUEST_ORIGIN') or f'http://127.0.0.1:{GUEST_PORT}').rstrip('/')
TRUST_PROXY = os.environ.get('TRUST_PROXY') == '1'
# Demo mode: sign-in codes are shown on screen and online checkout simulates a successful payment.
# Never enable for real guests or real money.
DEMO = os.environ.get('ENCORE_DEMO') == '1'

ADMIN_SESSION_DAYS, GUEST_SESSION_DAYS = 7, 30
OTP_TTL, OTP_RESEND, OTP_MAX_ATTEMPTS = 300, 60, 5
STAFF_ROLES = {
    'Owner': ['settings', 'config', 'event', 'menu', 'table', 'delete', 'order_status', 'checkin', 'checkin_ticket', 'settle', 'cancel'],
    'Admin': ['settings', 'config', 'event', 'menu', 'table', 'delete', 'order_status', 'checkin', 'checkin_ticket', 'settle', 'cancel'],
    'Service': ['order_status', 'settle', 'cancel'],
    'Gate': ['checkin', 'checkin_ticket'],
}
LOCK = threading.Lock()
ATTEMPTS = {}
_SECRET = None


# ---------------------------------------------------------------- storage

def conn():
    return db.connect(DB)


def init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    with conn() as c:
        db.create_schema(c)
        now = int(time.time())
        c.execute('DELETE FROM sessions WHERE expires<?', (now,))
        c.execute('DELETE FROM guest_sessions WHERE expires<?', (now,))
        c.execute('DELETE FROM otps WHERE expires<?', (now,))
        c.execute('DELETE FROM otp_log WHERE created<?', (now - 86400,))


def secret():
    """Server-side key for hashing one-time codes. Env var first, else a generated key file in the data directory."""
    global _SECRET
    if _SECRET is None:
        env = os.environ.get('ENCORE_SECRET')
        if env:
            _SECRET = env.encode()
        else:
            path = DB.parent / 'secret.key'
            if not path.exists():
                path.write_bytes(secrets.token_bytes(32))
                path.chmod(0o600)
            _SECRET = path.read_bytes()
    return _SECRET


def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()


def password(s):
    salt = secrets.token_bytes(16)
    return salt.hex() + ':' + hashlib.scrypt(s.encode(), salt=salt, n=16384, r=8, p=1).hex()


def verify(s, h):
    salt, hashed = h.split(':')
    return hmac.compare_digest(hashlib.scrypt(s.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex(), hashed)


def read_tenant(c, t):
    row = c.execute('SELECT * FROM tenants WHERE id=?', (t,)).fetchone()
    if not row:
        raise LookupError('Workspace not found.')
    return row, domain.upgrade(json.loads(row['state']))


def write_tenant(c, tenant_id, s):
    c.execute('UPDATE tenants SET state=?,name=?,version=version+1 WHERE id=?', (json.dumps(s), s['name'], tenant_id))


def notify(c, tenant, audience, title, body, guest=None, kind=None, ref=None):
    c.execute('INSERT INTO notifications(tenant,audience,guest,kind,title,body,ref,created) VALUES(?,?,?,?,?,?,?,?)',
              (tenant, audience, guest, kind, title, body, ref, int(time.time())))


def text_guest(phone, message):
    """Best-effort SMS for guest notifications. In-app notifications are always stored regardless."""
    try:
        sms.send(phone, message)
    except (sms.NotConfigured, sms.DeliveryFailed):
        pass


def rate_limited(key, limit, window):
    now = time.time()
    with LOCK:
        hits = [t for t in ATTEMPTS.get(key, []) if t > now - window]
        if len(hits) >= limit:
            ATTEMPTS[key] = hits
            return True
        hits.append(now)
        ATTEMPTS[key] = hits
    return False


def rating_summary(c, tenant, guest_id=None, recent=0):
    row = c.execute('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM ratings WHERE tenant=?', (tenant,)).fetchone()
    out = {'count': int(row['n'] or 0), 'average': round(float(row['avg']), 1) if row['n'] else None}
    if recent:
        out['recent'] = [dict(r) for r in c.execute("SELECT name,stars,comment,updated FROM ratings WHERE tenant=? AND comment<>'' ORDER BY updated DESC LIMIT ?", (tenant, recent))]
    if guest_id:
        mine = c.execute('SELECT stars,comment FROM ratings WHERE tenant=? AND guest=?', (tenant, guest_id)).fetchone()
        out['mine'] = dict(mine) if mine else None
    return out


class ApiError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status, self.code = status, code


# ---------------------------------------------------------------- HTTP

class BaseHandler(BaseHTTPRequestHandler):
    app = None
    origin = None
    page = None
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def client_ip(self):
        if TRUST_PROXY and self.headers.get('X-Forwarded-For'):
            return self.headers['X-Forwarded-For'].split(',')[0].strip()
        return self.client_address[0]

    def security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
        if PROD:
            self.send_header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

    def send(self, data, status=200, cookie=None):
        # Commit before the client can observe the response, so its next request sees this write.
        if status < 400 and getattr(self, 'db', None) is not None and self.db.in_transaction:
            self.db.commit()
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.security_headers()
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def make_cookie(self, name, value, maxage, samesite):
        return f'{name}={value}; Path=/; HttpOnly; SameSite={samesite}; Max-Age={maxage}' + ('; Secure' if PROD else '')

    def cookies(self):
        return dict(p.strip().split('=', 1) for p in self.headers.get('Cookie', '').split(';') if '=' in p)

    def serve_file(self, path):
        if path.startswith('/uploads/'):
            name = Path(path).name
            with conn() as c:
                row = c.execute('SELECT mime,data FROM uploads WHERE name=?', (name,)).fetchone()
            if row:
                body = bytes(row['data'])
                self.send_response(200)
                self.send_header('Content-Type', row['mime'])
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
                self.security_headers()
                self.end_headers()
                return self.wfile.write(body)
            file = UPLOADS / name  # images uploaded before uploads moved into the database
            if not file.is_file():
                return self.send({'error': 'Not found'}, 404)
        else:
            dist = ROOT / 'dist'
            candidate = (dist / path.lstrip('/')).resolve()
            root_file = path in ('/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest') \
                or bool(re.fullmatch(r'/wallets/[a-z-]+\.(?:png|svg|jpg|webp)', path))
            if (path.startswith('/assets/') or root_file) and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
                file = candidate
            else:
                file = dist / self.page
            if not file.is_file():
                return self.send({'error': 'Build the client before starting the application.'}, 404)
        body = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/manifest+json' if file.suffix == '.webmanifest' else mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable' if path.startswith('/assets/') else 'no-cache')
        self.security_headers()
        if file.suffix == '.html':
            hashes = ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(s).digest()).decode() + "'"
                              for s in re.findall(rb'<script[^>]*>(.*?)</script>', body, re.S) if s.strip())
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
                             "style-src 'self' 'unsafe-inline'; script-src 'self' " + hashes +
                             "; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.strip_admin_prefix()
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path.startswith('/api/'):
                with conn() as c:
                    if url.path == '/api/health':
                        return self.send({'ok': True, 'app': self.app, 'demo': DEMO, 'database': db.describe()})
                    return self.get_api(c, url.path, q)
            return self.serve_file(url.path)
        except ApiError as e:
            self.send({'error': str(e), 'code': e.code}, e.status)
        except PermissionError as e:
            self.send({'error': str(e)}, 401)
        except LookupError as e:
            self.send({'error': str(e)}, 404)
        except ValueError as e:
            self.send({'error': str(e)}, 400)
        except Exception:
            self.send({'error': 'The request could not be completed. Please try again.'}, 500)

    def do_POST(self):
        self.strip_admin_prefix()
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 7500000:
                self.close_connection = True
                return self.send({'error': 'Request is too large.'}, 413)
            raw = self.rfile.read(length)  # always drain the body so rejections are not lost to a connection reset
            origin = self.headers.get('Origin')
            if origin and origin != self.origin:
                raise PermissionError('Request origin is not allowed.')
            if not self.headers.get('Content-Type', '').startswith('application/json'):
                return self.send({'error': 'JSON required'}, 415)
            v = json.loads(raw)
            if not isinstance(v, dict):
                raise ValueError('Request must be a JSON object.')
            with conn() as c:
                c.execute('BEGIN IMMEDIATE')
                self.db = c
                try:
                    return self.post_api(c, path, v)
                finally:
                    self.db = None
        except ApiError as e:
            self.send({'error': str(e), 'code': e.code}, e.status)
        except PermissionError as e:
            self.send({'error': str(e)}, 401)
        except (ValueError, TypeError, KeyError) as e:
            self.send({'error': str(e) if isinstance(e, ValueError) else 'Invalid request.'}, 400)
        except db.IntegrityErrors:
            self.send({'error': 'An account with these details already exists.'}, 409)
        except LookupError as e:
            self.send({'error': str(e)}, 404)
        except Exception:
            self.send({'error': 'The request could not be completed. Please try again.'}, 500)

    def strip_admin_prefix(self):
        if self.app == 'admin' and self.path.startswith('/admin/api/'):
            self.path = self.path[len('/admin'):]

    def get_api(self, c, path, q):
        raise LookupError('Not found')

    def post_api(self, c, path, v):
        raise LookupError('Not found')


class AdminHandler(BaseHandler):
    app, page = 'admin', 'admin.html'

    @property
    def origin(self):
        return ADMIN_ORIGIN

    def user(self, c):
        token = self.cookies().get('encore_session', '')
        u = c.execute('SELECT u.* FROM users u JOIN sessions s ON s."user"=u.id WHERE s.token=? AND s.expires>?', (digest(token), time.time())).fetchone()
        if not u:
            raise PermissionError('Please sign in to continue.')
        return dict(u)

    def bundle(self, c, u):
        row, s = read_tenant(c, u['tenant'])
        team = [dict(r) for r in c.execute('SELECT id,name,email,role FROM users WHERE tenant=?', (u['tenant'],))]
        sms_status = {'provider': 'demo', 'delivers': False, 'label': 'Demo mode: sign-in codes are shown on screen, no SMS is sent'} if DEMO else sms.status()
        unread = c.execute("SELECT COUNT(*) FROM notifications WHERE tenant=? AND audience='staff' AND read=0", (u['tenant'],)).fetchone()[0]
        return {'user': {k: u[k] for k in ['id', 'name', 'email', 'role', 'tenant']}, 'state': s, 'version': row['version'], 'team': team,
                'paymentReady': DEMO, 'demo': DEMO, 'sms': sms_status, 'guestOrigin': GUEST_ORIGIN, 'unread': unread,
                'ratings': rating_summary(c, u['tenant'], recent=5)}

    def cookie(self, value, maxage=ADMIN_SESSION_DAYS * 86400):
        return self.make_cookie('encore_session', value, maxage, 'Strict')

    def get_api(self, c, path, q):
        if path == '/api/me':
            return self.send(self.bundle(c, self.user(c)))
        if path == '/api/notifications':
            u = self.user(c)
            rows = c.execute("SELECT id,kind,title,body,ref,created,read FROM notifications WHERE tenant=? AND audience='staff' ORDER BY created DESC,id DESC LIMIT 50", (u['tenant'],))
            return self.send([dict(r) for r in rows])
        raise LookupError('Not found')

    def post_api(self, c, path, v):
        if path in ['/api/signup', '/api/signin', '/api/recover']:
            if rate_limited('auth:' + self.client_ip(), 30, 900):
                raise ApiError(429, 'Too many attempts. Try again in 15 minutes.')
            mail = email(v.get('email'))
            pw = text(v.get('password'), 200)
            if path == '/api/signin':
                u = c.execute('SELECT * FROM users WHERE email=?', (mail,)).fetchone()
                if not u or not verify(pw, u['password']):
                    raise PermissionError('Email or password is incorrect.')
                token = uid() + uid()
                c.execute('INSERT INTO sessions VALUES(?,?,?)', (digest(token), u['id'], int(time.time()) + ADMIN_SESSION_DAYS * 86400))
                return self.send(self.bundle(c, dict(u)), cookie=self.cookie(token))
            if len(pw) < 12:
                raise ValueError('Use a password with at least 12 characters.')
            if path == '/api/recover':
                u = c.execute('SELECT * FROM users WHERE email=?', (mail,)).fetchone()
                if not u or not hmac.compare_digest(u['recovery'], digest(str(v.get('recovery', '')))):
                    raise PermissionError('Recovery details do not match.')
                recovery = uid()
                c.execute('UPDATE users SET password=?,recovery=? WHERE id=?', (password(pw), digest(recovery), u['id']))
                c.execute('DELETE FROM sessions WHERE "user"=?', (u['id'],))
                return self.send({'recovery': recovery})
            name = text(v.get('name'), 100)
            invite, role = v.get('invite'), 'Owner'
            if invite:
                inv = c.execute('SELECT * FROM invites WHERE token=? AND expires>?', (digest(str(invite)), time.time())).fetchone()
                if not inv or inv['email'] != mail:
                    raise ValueError('Invitation is invalid or expired.')
                tenant, role = inv['tenant'], inv['role']
                c.execute('DELETE FROM invites WHERE token=?', (digest(str(invite)),))
            else:
                team = text(v.get('team'), 80)
                tenant = uid()
                c.execute('INSERT INTO tenants(id,name,state) VALUES(?,?,?)', (tenant, team, json.dumps(domain.blank(team))))
            recovery = uid()
            u = {'id': uid(), 'tenant': tenant, 'name': name, 'email': mail, 'role': role}
            c.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?)', (u['id'], tenant, name, mail, password(pw), digest(recovery), role))
            token = uid() + uid()
            c.execute('INSERT INTO sessions VALUES(?,?,?)', (digest(token), u['id'], int(time.time()) + ADMIN_SESSION_DAYS * 86400))
            out = self.bundle(c, u)
            out['recovery'] = recovery
            return self.send(out, 201, self.cookie(token))

        if path not in ['/api/signout', '/api/profile', '/api/password', '/api/invite', '/api/team/remove', '/api/upload', '/api/notifications/read', '/api/action']:
            raise LookupError('Not found')
        u = self.user(c)
        if path == '/api/signout':
            c.execute('DELETE FROM sessions WHERE token=?', (digest(self.cookies().get('encore_session', '')),))
            return self.send({'ok': True}, cookie=self.cookie('', 0))
        if path == '/api/profile':
            name = text(v.get('name'), 100)
            c.execute('UPDATE users SET name=? WHERE id=?', (name, u['id']))
            u['name'] = name
            return self.send(self.bundle(c, u))
        if path == '/api/password':
            if not verify(text(v.get('current'), 200), u['password']):
                raise ValueError('Current password is incorrect.')
            pw = text(v.get('password'), 200)
            if len(pw) < 12:
                raise ValueError('Use at least 12 characters.')
            c.execute('UPDATE users SET password=? WHERE id=?', (password(pw), u['id']))
            c.execute('DELETE FROM sessions WHERE "user"=?', (u['id'],))
            return self.send({'ok': True}, cookie=self.cookie('', 0))
        if path == '/api/invite':
            if u['role'] not in ['Owner', 'Admin']:
                raise PermissionError('Only administrators can invite members.')
            role = v.get('role')
            if role not in ['Admin', 'Service', 'Gate']:
                raise ValueError('Select a role.')
            token = uid()
            c.execute('INSERT INTO invites VALUES(?,?,?,?,?)', (digest(token), u['tenant'], email(v.get('email')), role, int(time.time()) + 604800))
            return self.send({'url': ADMIN_ORIGIN + '/admin/signup?invite=' + token})
        if path == '/api/team/remove':
            if u['role'] != 'Owner':
                raise PermissionError('Only the workspace owner can remove members.')
            member = c.execute('SELECT * FROM users WHERE id=? AND tenant=?', (v.get('id'), u['tenant'])).fetchone()
            if not member or member['role'] == 'Owner':
                raise ValueError('This member cannot be removed.')
            c.execute('DELETE FROM sessions WHERE "user"=?', (member['id'],))
            c.execute('DELETE FROM users WHERE id=?', (member['id'],))
            return self.send(self.bundle(c, u))
        if path == '/api/upload':
            if u['role'] not in ['Owner', 'Admin']:
                raise PermissionError('Only administrators can upload images.')
            raw = base64.b64decode(v.get('data', ''), validate=True)
            if len(raw) > 5000000:
                raise ValueError('Choose an image smaller than 5 MB.')
            ext = 'png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else 'jpg' if raw.startswith(b'\xff\xd8\xff') else 'webp' if raw.startswith(b'RIFF') and raw[8:12] == b'WEBP' else None
            if not ext:
                raise ValueError('Upload a PNG, JPEG, or WebP image.')
            file = uid() + '.' + ext
            mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}[ext]
            c.execute('INSERT INTO uploads(name,mime,data,created) VALUES(?,?,?,?)', (file, mime, raw, int(time.time())))
            return self.send({'url': '/uploads/' + file})
        if path == '/api/notifications/read':
            c.execute("UPDATE notifications SET read=1 WHERE tenant=? AND audience='staff'", (u['tenant'],))
            return self.send({'ok': True})
        if path == '/api/action':
            op = v.get('op')
            if op not in STAFF_ROLES.get(u['role'], []):
                raise PermissionError('Your role does not allow this action.')
            row, s = read_tenant(c, u['tenant'])
            if v.get('version') != row['version']:
                raise ApiError(409, 'This workspace changed. Refresh before saving.')
            notices, data = [], v.get('data', {})
            s = domain.mutate(s, op, data, notices)
            write_tenant(c, u['tenant'], s)
            c.execute('INSERT INTO audit(tenant,"user",action,created) VALUES(?,?,?,?)', (u['tenant'], u['id'], op, int(time.time())))
            prefs = s['settings']['notifications']
            for n in notices:
                rec = n['record']
                if rec.get('guest'):
                    notify(c, u['tenant'], 'guest', n['title'], n['body'], rec['guest'], n['kind'], rec['ref'])
                    if n['kind'] == 'order_ready' and prefs['smsOrderReady']:
                        text_guest(rec['phone'], f'{s["name"]}: {n["body"]} Ref {rec["ref"]}.')
            out = self.bundle(c, u)
            if isinstance(data, dict) and data.get('result'):
                out['result'] = data['result']
            return self.send(out)
        raise LookupError('Not found')


class GuestHandler(BaseHandler):
    app, page = 'guest', 'guest.html'

    @property
    def origin(self):
        return GUEST_ORIGIN

    def guest(self, c, required=True):
        token = self.cookies().get('encore_guest', '')
        g = c.execute('SELECT g.* FROM guests g JOIN guest_sessions s ON s.guest=g.id WHERE s.token=? AND s.expires>?', (digest(token), time.time())).fetchone() if token else None
        if not g and required:
            raise PermissionError('Sign in with your phone number to continue.')
        return dict(g) if g else None

    def cookie(self, value, maxage=GUEST_SESSION_DAYS * 86400):
        # Lax so the session survives opening a table QR link from the phone's camera app.
        return self.make_cookie('encore_guest', value, maxage, 'Lax')

    def get_api(self, c, path, q):
        if path == '/api/workspaces':
            out = []
            for r in c.execute('SELECT id,name,state FROM tenants ORDER BY name'):
                st = domain.upgrade(json.loads(r['state']))
                profile, theme = st['settings']['profile'], st['settings']['theme']
                published = sorted((e for e in st['events'] if e.get('published')), key=lambda e: e['date'])
                upcoming = len(published)
                next_events = [{k: e.get(k) for k in ['id', 'name', 'date', 'venue', 'price', 'image']} for e in published[:3]]
                out.append({'id': r['id'], 'name': r['name'], 'description': st['description'], 'logo': theme['logo'],
                            'photo': (profile['photos'] or [theme['cover']])[0], 'city': profile['city'], 'address': profile['address'],
                            'events': upcoming, 'nextEvents': next_events, 'currency': st['currency'],
                            'rating': rating_summary(c, r['id']), 'mapLink': domain.map_link(st)})
            return self.send(out)
        if path == '/api/public':
            row, s = read_tenant(c, q.get('tenant', ''))
            out = domain.public_state(s)
            out['id'] = row['id']
            out['paymentReady'] = DEMO
            out['demo'] = DEMO
            viewer = self.guest(c, required=False)
            out['ratings'] = rating_summary(c, row['id'], viewer['id'] if viewer else None, recent=6)
            out['table'] = None
            if q.get('table'):
                t = domain.find_table(s, token=q['table'])
                if not t:
                    raise LookupError('This table link is invalid. Ask your host for a new QR code.')
                out['table'] = {k: t[k] for k in ['id', 'name', 'event', 'status']}
            return self.send(out)
        if path == '/api/table':
            if rate_limited('table:' + self.client_ip(), 30, 600):
                raise ApiError(429, 'Too many attempts. Please wait a few minutes.')
            row, s = read_tenant(c, q.get('tenant', ''))
            t = domain.find_table(s, code=q.get('code', '')) if q.get('code') else domain.find_table(s, token=q.get('token', ''))
            if not t:
                raise LookupError('We could not find that table. Check the code printed under the QR.')
            return self.send({'token': t['token'], 'name': t['name'], 'event': t['event'], 'status': t['status']})
        if path == '/api/receipt':
            row, s = read_tenant(c, q.get('tenant', ''))
            ref, tok = q.get('ref', ''), q.get('token', '')
            rec = next((r for r in s['orders'] + s['bookings'] if r.get('ref') == ref and tok and hmac.compare_digest(r.get('token', ''), tok)), None)
            if not rec:
                raise LookupError('We could not find that receipt. Check the link from your confirmation.')
            return self.send(domain.receipt(s, rec))
        if path == '/api/guest/me':
            g = self.guest(c, required=False)
            return self.send({'guest': {k: g[k] for k in ['id', 'name', 'phone']} if g else None})
        if path == '/api/guest/records':
            g = self.guest(c)
            row, s = read_tenant(c, q.get('tenant', ''))
            records = [domain.receipt(s, r) for r in s['bookings'] + s['orders'] if r.get('guest') == g['id']]
            records.sort(key=lambda r: r['created'], reverse=True)
            return self.send({'records': records, 'events': sorted(domain.guest_event_ids(s, g['id']))})
        if path == '/api/guest/notifications':
            g = self.guest(c)
            rows = c.execute('SELECT n.id,n.tenant,t.name AS merchant,n.kind,n.title,n.body,n.ref,n.created,n.read FROM notifications n '
                             "JOIN tenants t ON t.id=n.tenant WHERE n.audience='guest' AND n.guest=? ORDER BY n.created DESC,n.id DESC LIMIT 50", (g['id'],))
            return self.send([dict(r) for r in rows])
        raise LookupError('Not found')

    def post_api(self, c, path, v):
        if path == '/api/guest/otp':
            phone = domain.normalize_phone(v.get('phone'))
            now = int(time.time())
            if rate_limited('otp-ip:' + self.client_ip(), 20, 3600):
                raise ApiError(429, 'Too many code requests. Try again later.')
            last = c.execute('SELECT sent FROM otps WHERE phone=?', (phone,)).fetchone()
            if last and now - last['sent'] < OTP_RESEND:
                raise ApiError(429, f'Please wait {OTP_RESEND - (now - last["sent"])} seconds before requesting another code.', 'OTP_WAIT')
            if c.execute('SELECT COUNT(*) FROM otp_log WHERE phone=? AND created>?', (phone, now - 3600)).fetchone()[0] >= 5:
                raise ApiError(429, 'Too many codes were sent to this number. Try again in an hour.')
            code = f'{secrets.randbelow(1000000):06d}'
            try:
                if not DEMO:
                    sms.send(phone, f'Your Encore code is {code}. It expires in 5 minutes. Never share this code.')
            except sms.NotConfigured:
                raise ApiError(503, 'Phone sign-in is temporarily unavailable. Please try again later.', 'SMS_NOT_CONFIGURED')
            except sms.DeliveryFailed:
                raise ApiError(502, 'We could not send a code to this number. Check it and try again.', 'SMS_FAILED')
            c.execute('INSERT INTO otps(phone,code,expires,attempts,sent) VALUES(?,?,?,0,?) '
                      'ON CONFLICT(phone) DO UPDATE SET code=excluded.code,expires=excluded.expires,attempts=0,sent=excluded.sent',
                      (phone, hmac.new(secret(), (phone + ':' + code).encode(), 'sha256').hexdigest(), now + OTP_TTL, now))
            c.execute('INSERT INTO otp_log(phone,ip,created) VALUES(?,?,?)', (phone, self.client_ip(), now))
            out = {'sent': True, 'phone': phone, 'resendIn': OTP_RESEND, 'expiresIn': OTP_TTL}
            if DEMO:
                out['demoCode'] = code  # simulated SMS: shown on screen, nothing is sent
            return self.send(out)
        if path == '/api/guest/verify':
            phone = domain.normalize_phone(v.get('phone'))
            code = str(v.get('code', '')).strip()
            now = int(time.time())
            otp = c.execute('SELECT * FROM otps WHERE phone=?', (phone,)).fetchone()
            if not otp or otp['expires'] < now:
                raise ValueError('This code has expired. Request a new one.')
            if otp['attempts'] >= OTP_MAX_ATTEMPTS:
                raise ValueError('Too many incorrect codes. Request a new one.')
            expected = hmac.new(secret(), (phone + ':' + code).encode(), 'sha256').hexdigest()
            if not re.fullmatch(r'\d{6}', code) or not hmac.compare_digest(otp['code'], expected):
                c.execute('UPDATE otps SET attempts=attempts+1 WHERE phone=?', (phone,))
                c.execute('COMMIT')  # keep the failed-attempt count even though the request fails
                raise ValueError('That code is not correct.')
            g = c.execute('SELECT * FROM guests WHERE phone=?', (phone,)).fetchone()
            if not g:
                if not v.get('name'):
                    return self.send({'needsName': True})
                if v.get('acceptTerms') is not True:
                    raise ValueError('Please accept the terms to create your account.')
                g = {'id': uid(), 'phone': phone, 'name': text(v.get('name'), 80)}
                c.execute('INSERT INTO guests(id,phone,name,created,terms) VALUES(?,?,?,?,?)', (g['id'], phone, g['name'], now, now))
            c.execute('DELETE FROM otps WHERE phone=?', (phone,))
            token = uid() + uid()
            c.execute('INSERT INTO guest_sessions VALUES(?,?,?)', (digest(token), g['id'], now + GUEST_SESSION_DAYS * 86400))
            return self.send({'guest': {k: g[k] for k in ['id', 'name', 'phone']}}, cookie=self.cookie(token))
        if path == '/api/guest/signout':
            c.execute('DELETE FROM guest_sessions WHERE token=?', (digest(self.cookies().get('encore_guest', '')),))
            return self.send({'ok': True}, cookie=self.cookie('', 0))
        if path == '/api/quote':
            row, s = read_tenant(c, text(v.get('tenant')))
            g = self.guest(c, required=False)
            return self.send(domain.quote_order(s, v, g['id'] if g else None))
        if path == '/api/checkout' and not DEMO:
            read_tenant(c, text(v.get('tenant')))
            # Fail closed until the AfroPay merchant contract and credentials are configured.
            raise ApiError(503, 'Online payments are not available yet. You can reserve and pay at the venue.', 'PAYMENT_NOT_CONFIGURED')

        if path not in ['/api/guest/profile', '/api/guest/notifications/read', '/api/order', '/api/checkout', '/api/guest/rating']:
            raise LookupError('Not found')
        g = self.guest(c)
        if path == '/api/guest/profile':
            name = text(v.get('name'), 80)
            c.execute('UPDATE guests SET name=? WHERE id=?', (name, g['id']))
            return self.send({'guest': {'id': g['id'], 'name': name, 'phone': g['phone']}})
        if path == '/api/guest/rating':
            row, st = read_tenant(c, text(v.get('tenant')))
            if not any(r.get('guest') == g['id'] for r in st['bookings'] + st['orders']):
                raise PermissionError('You can rate an organizer after booking tickets or ordering with them.')
            stars = domain.whole(v.get('stars'), 1, 5, 'Choose 1 to 5 stars.')
            comment = domain.text(v.get('comment'), 500, False)
            now = int(time.time())
            c.execute('INSERT INTO ratings(tenant,guest,stars,comment,name,created,updated) VALUES(?,?,?,?,?,?,?) '
                      'ON CONFLICT(tenant,guest) DO UPDATE SET stars=excluded.stars,comment=excluded.comment,name=excluded.name,updated=excluded.updated',
                      (row['id'], g['id'], stars, comment, g['name'].split(' ')[0], now, now))
            notify(c, row['id'], 'staff', f'New {stars}-star rating', comment or f'{g["name"].split(" ")[0]} rated {st["name"]} {stars} of 5.', kind='rating')
            return self.send(rating_summary(c, row['id'], g['id'], recent=6))
        if path == '/api/guest/notifications/read':
            c.execute("UPDATE notifications SET read=1 WHERE audience='guest' AND guest=?", (g['id'],))
            return self.send({'ok': True})
        if path in ('/api/order', '/api/checkout'):
            demo_payment = path == '/api/checkout'  # only reachable here when DEMO is on
            if rate_limited('order:' + self.client_ip(), 30, 900) or rate_limited('order-guest:' + g['id'], 20, 900):
                raise ApiError(429, 'Too many orders in a short time. Please wait a few minutes.')
            row, s = read_tenant(c, text(v.get('tenant')))
            rec = domain.guest_record(s, v, g, demo_payment=demo_payment)
            write_tenant(c, row['id'], s)
            c.execute('INSERT INTO audit(tenant,"user",action,created) VALUES(?,?,?,?)', (row['id'], 'guest:' + g['id'], 'guest_' + str(v.get('kind')), int(time.time())))
            prefs = s['settings']['notifications']
            if rec.get('qty'):
                title, body = ('Tickets confirmed', f'{rec["qty"]} ticket{"s" if rec["qty"] > 1 else ""} for {rec["eventName"]}. Paid (demo payment). Ref {rec["ref"]}.') if demo_payment else \
                    ('Tickets reserved', f'{rec["qty"]} ticket{"s" if rec["qty"] > 1 else ""} for {rec["eventName"]}. Pay at the entrance. Ref {rec["ref"]}.')
                notify(c, row['id'], 'staff', f'New booking · {rec["ref"]}', f'{g["name"]} reserved {rec["qty"]} for {rec["eventName"]}.', kind='booking', ref=rec['ref'])
                if prefs['smsBookings']:
                    text_guest(g['phone'], f'{s["name"]}: {body}')
            else:
                title, body = 'Order received', f'{rec["items"]} for {rec.get("tableName") or "counter pickup"}. Ref {rec["ref"]}.'
                if prefs['staffNewOrders']:
                    notify(c, row['id'], 'staff', f'New order · {rec["ref"]}', f'{rec.get("tableName") or "Counter"}: {rec["items"]}', kind='order', ref=rec['ref'])
            notify(c, row['id'], 'guest', title, body, g['id'], 'placed', rec['ref'])
            return self.send(domain.receipt(s, rec), 201)
        raise LookupError('Not found')


class CombinedHandler(BaseHandler):
    """One listener for both apps: /admin and /admin/api/* go to the admin app, everything else to the guest app."""

    def dispatch(self, method):
        # Route every request: keep-alive connections reuse this handler for later requests.
        path = urlparse(self.path).path
        self.__class__ = AdminHandler if path == '/admin' or path.startswith('/admin/') else GuestHandler
        try:
            return getattr(self, method)()
        finally:
            self.__class__ = CombinedHandler

    def do_GET(self):
        return self.dispatch('do_GET')

    def do_POST(self):
        return self.dispatch('do_POST')


def serve(handler, host, port):
    http = ThreadingHTTPServer((host, port), handler)
    http.daemon_threads = True
    return http


def production_problems():
    problems = []
    if PROD:
        for name, origin in [('ADMIN_ORIGIN', ADMIN_ORIGIN), ('GUEST_ORIGIN', GUEST_ORIGIN)]:
            if not origin.startswith('https://'):
                problems.append(f'{name} must be an https:// origin in production.')
        if not os.environ.get('ENCORE_SECRET'):
            problems.append('ENCORE_SECRET must be set in production (32+ random bytes, base64 or hex).')
        if DEMO:
            problems.append('ENCORE_DEMO=1 (SMS_PROVIDER not required): sign-in codes are shown on screen and payments are simulated. Not for real guests or money.')
        elif sms.demo_log_allowed():
            problems.append('SMS_PROVIDER=log demo mode: sign-in codes are written to server logs, not sent. Not for real guests.')
        elif not sms.status()['delivers']:
            problems.append('SMS_PROVIDER is not configured; guest phone sign-in will be unavailable.')
    return problems


if __name__ == '__main__':
    if sys.version_info < (3, 11) or not hasattr(hashlib, 'scrypt'):
        raise SystemExit('Encore requires Python 3.11+ with scrypt support. Run: python3 launch.py')
    problems = production_problems()
    for problem in problems:
        print(('WARNING: ' if 'SMS_PROVIDER' in problem else 'ERROR: ') + problem, flush=True)
    if any('SMS_PROVIDER' not in p for p in problems):
        raise SystemExit('Encore will not start in production until these are fixed. See .env.example.')
    init()
    host = os.environ.get('HOST', '127.0.0.1')
    servers = [serve(CombinedHandler, host, ADMIN_PORT)] if SINGLE_PORT else [serve(AdminHandler, host, ADMIN_PORT), serve(GuestHandler, host, GUEST_PORT)]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f'Encore admin: {ADMIN_ORIGIN}\nEncore guest: {GUEST_ORIGIN}', flush=True)
    servers[0].serve_forever()
