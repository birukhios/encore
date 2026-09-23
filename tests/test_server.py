import http.client
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import domain
import server as s
import sms

SENT = []


def capture_sms(phone, text):
    SENT.append((phone, text))


class Client:
    def __init__(self, port, prefix='/api/'):
        self.port, self.cookies, self.prefix = port, {}, prefix

    def __call__(self, path, data=None, origin=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port)
        h = {}
        if data is not None:
            h['Content-Type'] = 'application/json'
        if self.cookies:
            h['Cookie'] = '; '.join(f'{k}={v}' for k, v in self.cookies.items())
        if origin:
            h['Origin'] = origin
        c.request('POST' if data is not None else 'GET', self.prefix + path, json.dumps(data) if data is not None else None, h)
        r = c.getresponse()
        body = json.loads(r.read())
        cookie = r.getheader('Set-Cookie')
        if cookie:
            name, value = cookie.split(';')[0].split('=', 1)
            if value:
                self.cookies[name] = value
            else:
                self.cookies.pop(name, None)
        c.close()
        return r.status, body


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        s.DATA = Path(cls.temp.name)
        s.UPLOADS = Path(cls.temp.name) / 'uploads'
        s._SECRET = None
        s.db.reset_pool()          # pick up the DATABASE_URL the test runner provided
        with s.conn() as c:        # each run starts from an empty schema
            for table in ('platform_audit', 'platform_sessions', 'platform_admins', 'ratings', 'notifications', 'otp_log',
                          'otps', 'guest_sessions', 'guests', 'audit', 'invites', 'sessions', 'users', 'uploads', 'tenants'):
                c.execute(f'DROP TABLE IF EXISTS {table} CASCADE')
        s.init()
        cls.original_send = sms.send
        sms.PROVIDERS['test'] = capture_sms
        sms.os.environ['SMS_PROVIDER'] = 'test'
        cls.admin = s.serve(s.AdminHandler, '127.0.0.1', 0)
        cls.guest = s.serve(s.GuestHandler, '127.0.0.1', 0)
        for srv in [cls.admin, cls.guest]:
            threading.Thread(target=srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        sms.os.environ.pop('SMS_PROVIDER', None)
        sms.PROVIDERS.pop('test', None)
        for srv in [cls.admin, cls.guest]:
            srv.shutdown()
            srv.server_close()
        cls.temp.cleanup()

    def setUp(self):
        s.ATTEMPTS.clear()

    def staff(self):
        c = Client(self.admin.server_port)
        pw = secrets.token_urlsafe(24)
        mail = secrets.token_hex(5) + '@example.com'
        status, b = c('signup', {'name': 'Test Organizer', 'team': 'Test Workspace', 'email': mail, 'password': pw})
        self.assertEqual(status, 201)
        return c, b, mail, pw

    def act(self, c, op, data):
        me = c('me')
        self.assertIn('version', me[1], me)
        status, body = c('action', {'op': op, 'version': me[1]['version'], 'data': data})
        return status, body

    def guest_client(self, name='Guest'):
        g = Client(self.guest.server_port)
        phone = '09' + ''.join(secrets.choice('0123456789') for _ in range(8))
        status, sent = g('guest/otp', {'phone': phone})
        self.assertEqual(status, 200)
        code = sent.get('demoCode') or re.search(r'\b(\d{6})\b', SENT[-1][1]).group(1)
        self.assertEqual(g('guest/verify', {'phone': phone, 'code': code})[1], {'needsName': True})
        status, body = g('guest/verify', {'phone': phone, 'code': code, 'name': name, 'acceptTerms': True})
        self.assertEqual(status, 200)
        return g, body['guest']

    def concert(self, c, capacity=10, price='100'):
        self.act(c, 'event', {'name': 'Show', 'description': 'Live', 'date': '2026-11-02T18:00', 'venue': 'Hall', 'price': price, 'capacity': capacity, 'published': True})
        return c('me')[1]['state']['events'][-1]

    # ------------------------------------------------------------ organizer accounts

    def test_account_session_logout_and_recovery(self):
        c, b, mail, pw = self.staff()
        self.assertEqual(c('me')[0], 200)
        anon = Client(self.admin.server_port)
        self.assertEqual(anon('signin', {'email': mail, 'password': 'wrong'})[0], 401)
        c('signout', {})
        self.assertEqual(c('me')[0], 401)
        new = secrets.token_urlsafe(24)
        self.assertEqual(anon('recover', {'email': mail, 'password': new, 'recovery': b['recovery']})[0], 200)
        self.assertEqual(anon('signin', {'email': mail, 'password': new})[0], 200)
        self.assertEqual(Client(self.admin.server_port)('signin', {'email': mail, 'password': pw})[0], 401)

    def test_tenant_isolation_and_optimistic_updates(self):
        a, _, _, _ = self.staff()
        b, bb, _, _ = self.staff()
        v = {'op': 'settings', 'version': 0, 'data': {'name': 'Only A', 'description': 'A private workspace', 'currency': 'USD'}, 'tenant': bb['user']['tenant']}
        self.assertEqual(a('action', v)[0], 200)
        self.assertEqual(b('me')[1]['state']['name'], 'Test Workspace')
        self.assertEqual(a('action', v)[0], 409)

    def test_apps_are_separated_by_port(self):
        c, _, _, _ = self.staff()
        g = Client(self.guest.server_port)
        g.cookies = dict(c.cookies)
        self.assertEqual(g('me')[0], 404)
        self.assertEqual(g('action', {'op': 'settings', 'version': 0, 'data': {}})[0], 404)
        self.assertEqual(Client(self.admin.server_port)('guest/otp', {'phone': '0911111111'})[0], 404)
        self.assertEqual(Client(self.admin.server_port)('workspaces')[0], 404)

    def test_single_port_routing(self):
        combined = s.serve(s.CombinedHandler, '127.0.0.1', 0)
        threading.Thread(target=combined.serve_forever, daemon=True).start()
        try:
            port = combined.server_port
            admin, guest = Client(port, '/admin/api/'), Client(port)
            status, body = admin('signup', {'name': 'One Port', 'team': 'Single', 'email': secrets.token_hex(5) + '@example.com', 'password': secrets.token_urlsafe(24)})
            self.assertEqual(status, 201)
            self.assertEqual(admin('me')[0], 200)
            self.assertEqual(guest('health')[1]['app'], 'guest')
            self.assertEqual(guest('me')[0], 404)
            self.assertEqual(guest('public?tenant=' + body['user']['tenant'])[1]['name'], 'Single')
            keep = http.client.HTTPConnection('127.0.0.1', port)
            for path, app in [('/admin/api/health', 'admin'), ('/api/health', 'guest'), ('/admin/api/health', 'admin')]:
                keep.request('GET', path)
                self.assertEqual(json.loads(keep.getresponse().read())['app'], app, path)
            keep.close()
            for path, marker in [('/admin/signin', b'src/admin'), ('/', b'src/guest')]:
                c = http.client.HTTPConnection('127.0.0.1', port)
                c.request('GET', path)
                page = c.getresponse().read()
                c.close()
                self.assertTrue(marker in page or b'assets/' in page, path)
        finally:
            combined.shutdown()
            combined.server_close()

    def test_table_qr_and_public_filtering(self):
        c, b, _, _ = self.staff()
        self.act(c, 'event', {'name': 'Concert', 'description': 'Live show', 'date': '2026-11-02T18:00', 'venue': 'Hall', 'price': '10.50', 'capacity': 100, 'published': False})
        e = c('me')[1]['state']['events'][0]
        t = b['user']['tenant']
        g = Client(self.guest.server_port)
        self.assertEqual(g('public?tenant=' + t)[1]['events'], [])
        self.act(c, 'table', {'name': 'Table 1', 'event': e['id'], 'seats': 4})
        self.act(c, 'table', {'name': 'Table 2', 'event': e['id'], 'seats': 4})
        tables = c('me')[1]['state']['tables']
        self.assertNotEqual(tables[0]['token'], tables[1]['token'])
        self.assertNotEqual(tables[0]['code'], tables[1]['code'])
        pub = g('public?tenant=' + t + '&table=' + tables[0]['token'])[1]
        self.assertEqual(pub['table']['name'], 'Table 1')
        self.assertEqual(g('table?tenant=' + t + '&code=' + tables[1]['code'].lower())[1]['token'], tables[1]['token'])
        self.assertEqual(g('public?tenant=' + t + '&table=wrong')[0], 404)

    def test_roles_invites_and_member_removal(self):
        c, _, _, _ = self.staff()
        mail = secrets.token_hex(4) + '@example.com'
        token = c('invite', {'email': mail, 'role': 'Service'})[1]['url'].split('invite=')[1]
        svc = Client(self.admin.server_port)
        status, body = svc('signup', {'name': 'Service Staff', 'email': mail, 'password': secrets.token_urlsafe(24), 'invite': token})
        self.assertEqual(status, 201)
        self.assertEqual(svc('action', {'op': 'settings', 'version': 0, 'data': {}})[0], 401)
        self.assertEqual(svc('team/remove', {'id': body['user']['id']})[0], 401)
        self.assertEqual(c('team/remove', {'id': body['user']['id']})[0], 200)
        self.assertEqual(svc('me')[0], 401)

    def test_payment_cannot_be_forged(self):
        c, b, _, _ = self.staff()
        status, body = Client(self.guest.server_port)('checkout', {'tenant': b['user']['tenant'], 'kind': 'booking', 'paid': True, 'total': 1})
        self.assertEqual((status, body['code']), (503, 'PAYMENT_NOT_CONFIGURED'))
        state = c('me')[1]['state']
        self.assertEqual((state['orders'], state['bookings']), ([], []))

    def test_profile_avatar_and_old_database_migration(self):
        c, _, _, _ = self.staff()
        png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
        url = c('upload', {'data': png})[1]['url']
        self.assertEqual(c('profile', {'name': 'Pic Owner', 'avatar': 'https://evil.example/x.png'})[0], 400)
        body = c('profile', {'name': 'Pic Owner', 'avatar': url})[1]
        self.assertEqual((body['user']['avatar'], body['team'][0]['avatar']), (url, url))
        self.assertEqual(c('profile', {'name': 'Pic Owner'})[1]['user']['avatar'], url)  # unchanged when omitted
        photos = [url] * 40
        self.assertEqual(self.act(c, 'config', {'group': 'profile', 'values': {'city': 'Addis Ababa', 'address': '', 'mapUrl': '', 'photos': photos}})[0], 200)
        # A database created before `avatar` existed gains the column, and running the migration twice is safe.
        with s.conn() as con:
            con.execute('CREATE TABLE IF NOT EXISTS legacy_users(id TEXT PRIMARY KEY,name TEXT NOT NULL)')
            con.execute('ALTER TABLE legacy_users DROP COLUMN IF EXISTS avatar')
            s.db.migrate(con)
            con.execute("INSERT INTO legacy_users VALUES('u','Old') ON CONFLICT (id) DO NOTHING")
            s.db.migrate(con)  # idempotent
            con.execute('DROP TABLE legacy_users')

    def test_csrf_and_upload_validation(self):
        c, _, _, _ = self.staff()
        self.assertEqual(c('profile', {'name': 'Altered'}, 'https://attacker.invalid')[0], 401)
        self.assertEqual(c('upload', {'data': 'PHNjcmlwdD4='})[0], 400)

    # ------------------------------------------------------------ settings

    def test_settings_validation_and_enforcement(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        self.assertEqual(self.act(c, 'config', {'group': 'theme', 'values': {'accent': '#FFEEEE', 'mode': 'dark'}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'theme', 'values': {'accent': '#1A4DB3', 'mode': 'dark', 'adminMode': 'dusk'}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'theme', 'values': {'accent': '#1A4DB3', 'mode': 'dark', 'adminMode': 'dark'}})[0], 200)
        self.assertEqual(self.act(c, 'config', {'group': 'ordering', 'values': {'enabled': True, 'requireScan': False, 'ticketHoldersOnly': True}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'support', 'values': {'email': 'help@example.com', 'faq': [{'q': 'Parking?', 'a': 'Free.'}]}})[0], 200)
        self.act(c, 'config', {'group': 'legal', 'values': {'terms': 'Be kind.', 'privacy': ''}})
        pub = Client(self.guest.server_port)('public?tenant=' + t)[1]
        self.assertEqual(pub['settings']['theme'], {'accent': '#1A4DB3', 'mode': 'dark', 'adminMode': 'dark', 'logo': '', 'cover': ''})
        self.assertEqual(pub['settings']['support']['faq'][0]['q'], 'Parking?')
        self.assertEqual(pub['settings']['legal']['terms'], 'Be kind.')
        e = self.concert(c)
        g, _ = self.guest_client()
        self.act(c, 'config', {'group': 'ticketing', 'values': {'enabled': True, 'maxPerOrder': 2}})
        self.assertIn('up to 2', g('quote', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 3})[1]['error'])
        self.act(c, 'config', {'group': 'ticketing', 'values': {'enabled': False, 'maxPerOrder': 2}})
        self.assertIn('closed', g('quote', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[1]['error'])

    # ------------------------------------------------------------ guests

    def test_guest_otp_rules(self):
        g = Client(self.guest.server_port)
        self.assertEqual(g('guest/otp', {'phone': '12'})[0], 400)
        self.assertEqual(g('guest/otp', {'phone': '0922 000 111'})[0], 200)
        self.assertEqual(SENT[-1][0], '+251922000111')
        self.assertEqual(g('guest/otp', {'phone': '+251922000111'})[1]['code'], 'OTP_WAIT')
        for _ in range(5):
            self.assertEqual(g('guest/verify', {'phone': '0922000111', 'code': '000000'})[0], 400)
        code = re.search(r'\b(\d{6})\b', SENT[-1][1]).group(1)
        self.assertIn('Too many', g('guest/verify', {'phone': '0922000111', 'code': code})[1]['error'])
        self.assertEqual(g('guest/me')[1], {'guest': None})
        self.assertEqual(g('order', {'tenant': 'x', 'kind': 'booking'})[0], 401)

    def test_otp_fails_closed_without_provider(self):
        sms.os.environ['SMS_PROVIDER'] = ''
        sms.os.environ['ENCORE_ENV'] = 'production'
        try:
            status, body = Client(self.guest.server_port)('guest/otp', {'phone': '0933000111'})
            self.assertEqual((status, body['code']), (503, 'SMS_NOT_CONFIGURED'))
        finally:
            sms.os.environ['SMS_PROVIDER'] = 'test'
            sms.os.environ.pop('ENCORE_ENV')

    def test_online_payments_fail_closed_and_cash_is_opt_in(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c)
        g, _ = self.guest_client('Cash Guest')
        # No sign-in code is ever returned to the browser.
        self.assertNotIn('demoCode', g('guest/otp', {'phone': '0944000111'})[1])
        # Online checkout fails closed until a payment provider is connected.
        self.assertEqual(g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[1]['code'], 'PAYMENT_NOT_CONFIGURED')
        self.assertFalse(g('public?tenant=' + t)[1]['paymentReady'])
        # Cash for tickets is off by default.
        status, body = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1, 'payment': 'cash'})
        self.assertEqual((status, body['error']), (400, 'This organizer only accepts online payment for tickets.'))
        self.act(c, 'config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}})
        status, rec = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1, 'payment': 'cash'})
        self.assertEqual((status, rec['paid'], rec['settlement'], rec['total']), (201, False, 'cash', 11500))
        # Staff record the money; only then can the guest be checked in.
        self.assertIn('payment', self.act(c, 'checkin', {'id': c('me')[1]['state']['bookings'][0]['id']})[1]['error'])
        booking = c('me')[1]['state']['bookings'][0]
        self.assertEqual(self.act(c, 'settle', {'id': booking['id'], 'method': 'Cash'})[0], 200)
        self.assertEqual(self.act(c, 'checkin', {'id': booking['id']})[0], 200)

    def test_online_tickets_reference_checkin_and_notifications(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c, capacity=3)
        g, guest = self.guest_client('Guest One')
        online = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2})
        self.assertEqual((online[0], online[1]['error']), (400, 'Tickets are paid online only.'))
        self.act(c, 'config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}})
        status, rec = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2, 'payment': 'cash', 'total': 1, 'paid': True})
        self.assertEqual(status, 201)
        self.assertEqual((rec['total'], rec['paid'], rec['status'], len(rec['tickets']), rec['name']), (23000, False, 'Reserved', 2, 'Guest One'))
        g2, _ = self.guest_client()
        self.assertEqual(g2('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2, 'payment': 'cash'})[0], 400)  # capacity
        self.assertEqual(self.act(c, 'settle', {'id': c('me')[1]['state']['bookings'][0]['id'], 'method': 'Cash'})[0], 200)
        self.assertEqual(g2('guest/records?tenant=' + t)[1]['records'], [])
        self.assertEqual(g('guest/records?tenant=' + t)[1]['events'], [e['id']])
        ticket = rec['tickets'][0]
        status, body = self.act(c, 'checkin_ticket', {'code': f'{rec["ref"]}:1:{ticket["token"]}'})
        self.assertEqual((status, body['result']['serial'], body['result']['remaining']), (200, 1, 1))
        self.assertEqual(self.act(c, 'checkin_ticket', {'code': f'{rec["ref"]}:1:{ticket["token"]}'})[0], 400)
        # typed reference number admits the next unused ticket; case and prefix are forgiving
        status, body = self.act(c, 'checkin_ticket', {'code': ' ' + rec['ref'][3:].lower() + ' '})
        self.assertEqual((status, body['result']['serial'], body['result']['remaining']), (200, 2, 0))
        self.assertIn('already been checked in', self.act(c, 'checkin_ticket', {'code': rec['ref']})[1]['error'])
        self.assertEqual(self.act(c, 'checkin_ticket', {'code': 'EN-ZZZZZZ'})[0], 400)
        booking = c('me')[1]['state']['bookings'][0]
        self.assertEqual(booking['status'], 'Checked in')
        self.assertEqual({t['usedBy'] for t in booking['tickets']}, {'Test Organizer'})
        self.assertTrue(all(t['usedAt'] for t in booking['tickets']))
        self.assertNotIn('usedBy', g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=' + rec['token'])[1]['tickets'][0])
        other, _, _, _ = self.staff()
        self.assertEqual(self.act(other, 'checkin_ticket', {'code': rec['ref']})[0], 400)  # other workspace
        titles = [n['title'] for n in g('guest/notifications')[1]]
        self.assertIn('Tickets reserved', titles)
        self.assertTrue(any('New booking' in n['title'] for n in c('notifications')[1]))

    def test_table_scan_event_menu_tip_and_tracking(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c, price='0')
        other = self.concert(c, price='0')
        self.act(c, 'menu', {'name': 'Tea', 'description': 'Hot', 'price': '50', 'category': 'Drinks', 'available': True, 'events': [e['id']]})
        self.act(c, 'menu', {'name': 'Cake', 'description': 'Sweet', 'price': '80', 'category': 'Food', 'available': True, 'events': [other['id']]})
        menu = c('me')[1]['state']['menu']
        self.act(c, 'table', {'name': 'Table 3', 'event': e['id'], 'seats': 4})
        tok = c('me')[1]['state']['tables'][0]['token']
        g, guest = self.guest_client()
        tea = {menu[0]['id']: 2}
        self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea})[1]['error'], 'Orders are paid online only.')
        self.act(c, 'config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}})
        cash = lambda data: g('order', {**data, 'tenant': t, 'payment': 'cash'})
        self.assertIn('Scan', cash({'kind': 'menu', 'items': tea})[1]['error'])
        self.assertIn('ticket holders', cash({'kind': 'menu', 'items': tea, 'table': tok})[1]['error'])
        self.assertEqual(cash({'kind': 'booking', 'event': e['id'], 'qty': 1})[0], 201)
        self.assertIn('not served', cash({'kind': 'menu', 'items': {menu[1]['id']: 1}, 'table': tok})[1]['error'])
        self.assertEqual(cash({'kind': 'menu', 'items': tea, 'table': 'forged'})[0], 400)
        self.act(c, 'config', {'group': 'tips', 'values': {'enabled': True, 'presets': [10, 50], 'custom': False}})
        self.assertEqual(cash({'kind': 'menu', 'items': tea, 'tipAmount': '7', 'table': tok})[0], 400)
        for bad in ['-5', '10.555', 'abc']:
            self.assertEqual(cash({'kind': 'menu', 'items': tea, 'tipAmount': bad, 'table': tok})[0], 400, bad)
        status, rec = cash({'kind': 'menu', 'items': tea, 'tipAmount': '10', 'table': tok})
        self.assertEqual(status, 201)
        self.assertEqual((rec['subtotal'], rec['tip'], rec['total'], rec['tableName'], rec['status'], rec['paid']), (10000, 1000, 12500, 'Table 3', 'Placed', False))  # 100.00 + 15.00 VAT + 10.00 tip
        order = c('me')[1]['state']['orders'][0]
        for status_name in ['Preparing', 'Ready', 'Delivered']:
            self.assertEqual(self.act(c, 'order_status', {'id': order['id'], 'status': status_name})[0], 200)
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=' + rec['token'])[1]['status'], 'Delivered')
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=wrong')[0], 404)
        self.assertTrue(any('ready' in msg and phone == guest['phone'] for phone, msg in SENT))


    def test_sms_failures_are_logged_without_the_number_or_secrets(self):
        import io
        from contextlib import redirect_stderr
        captured = io.StringIO()
        original = sms.PROVIDERS.get('test')
        sms.PROVIDERS['test'] = lambda phone, text: (_ for _ in ()).throw(sms.DeliveryFailed('403: invalid sender name'))
        try:
            with redirect_stderr(captured):
                status, body = Client(self.guest.server_port)('guest/otp', {'phone': '0955 123 456'})
        finally:
            sms.PROVIDERS['test'] = original
        self.assertEqual((status, body['code']), (502, 'SMS_FAILED'))
        logged = captured.getvalue()
        self.assertIn('invalid sender name', logged)      # operators see the provider's reason
        self.assertNotIn('955123456', logged)             # the full number does not reach the log
        self.assertNotIn('invalid sender', body['error'])  # nor does the reason reach the guest
        self.assertEqual(s.mask_phone('+251911234567'), '+2519****4567')

    def test_guest_signs_in_with_a_code_the_provider_verifies(self):
        """AfroMessage's challenge endpoint issues the code; Encore stores only the verification id."""
        asked = []
        original_send, original_verify = sms.send_signin_code, sms.verify_signin_code
        sms.send_signin_code = lambda phone, code, ttl, length=6: ('IGNORED', 'vid-42')
        sms.verify_signin_code = lambda phone, code, vid: bool(asked.append((phone, code, vid))) or (code == 'A1B2C3' and vid == 'vid-42')
        g = Client(self.guest.server_port)
        try:
            self.assertEqual(g('guest/otp', {'phone': '0966 123 123'})[0], 200)
            with s.conn() as c:
                stored = c.execute('SELECT code FROM otps WHERE phone=?', ('+251966123123',)).fetchone()['code']
            self.assertEqual(stored, 'provider:vid-42')  # the code itself is never stored
            self.assertEqual(g('guest/verify', {'phone': '0966123123', 'code': 'WRONG1'})[0], 400)
            status, body = g('guest/verify', {'phone': '0966123123', 'code': 'A1B2C3', 'name': 'Provider Guest', 'acceptTerms': True})
            self.assertEqual((status, body['guest']['name']), (200, 'Provider Guest'))
        finally:
            sms.send_signin_code, sms.verify_signin_code = original_send, original_verify
        self.assertEqual([a[2] for a in asked], ['vid-42', 'vid-42'])
        self.assertEqual(g('guest/me')[1]['guest']['phone'], '+251966123123')

    def test_env_file_fills_gaps_without_overriding(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env'
            os.environ.pop('ENCORE_SKIP_DOTENV', None)
            path.write_text('# comment\nSMS_PROVIDER=afromessage\nAFROMESSAGE_TOKEN="from-file"\n'
                            'ENCORE_ENV=production\nbroken line\nPORT=8081   # organizer admin\n'
                            'ENCORE_SECRET="keeps # inside quotes"\n')
            os.environ['ENCORE_ENV'] = 'development'  # a real variable must win
            os.environ.pop('AFROMESSAGE_TOKEN', None)
            provider = os.environ.get('SMS_PROVIDER')
            try:
                s.load_env_file(path)
                self.assertEqual(os.environ['AFROMESSAGE_TOKEN'], 'from-file')
                self.assertEqual(os.environ['ENCORE_ENV'], 'development')
                self.assertEqual(os.environ['SMS_PROVIDER'], provider)  # already set by the test harness
                self.assertEqual(os.environ['PORT'], '8081')                     # inline comments are stripped
                self.assertEqual(os.environ['ENCORE_SECRET'], 'keeps # inside quotes')  # quoted values keep theirs
            finally:
                for key in ('AFROMESSAGE_TOKEN', 'ENCORE_ENV', 'PORT', 'ENCORE_SECRET'):
                    os.environ.pop(key, None)
        self.assertEqual(s.load_env_file(Path(folder) / 'missing.env'), 0)

    def test_head_robots_and_gzip(self):
        import gzip as gz
        c = http.client.HTTPConnection('127.0.0.1', self.guest.server_port)
        c.request('HEAD', '/api/health')
        r = c.getresponse()
        self.assertEqual((r.status, r.read()), (200, b''))
        self.assertGreater(int(r.getheader('Content-Length')), 0)
        c.request('GET', '/robots.txt')
        r = c.getresponse()
        self.assertIn(b'Disallow: /admin', r.read())
        c.request('GET', '/api/workspaces', headers={'Accept-Encoding': 'gzip'})
        r = c.getresponse()
        body = r.read()
        data = gz.decompress(body) if r.getheader('Content-Encoding') == 'gzip' else body
        self.assertIsInstance(json.loads(data), list)
        c.close()

    # ------------------------------------------------------------ platform console

    def test_platform_admin_console_and_suspension(self):
        c, b, mail, pw = self.staff()
        tenant = b['user']['tenant']
        event = self.concert(c)
        g, guest = self.guest_client('Platform Guest')
        self.act(c, 'config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}})
        self.assertEqual(g('order', {'tenant': tenant, 'kind': 'booking', 'event': event['id'], 'qty': 1, 'payment': 'cash'})[0], 201)

        platform = Client(self.admin.server_port)
        self.assertEqual(platform('platform/data')[0], 401)
        self.assertEqual(c('platform/data')[0], 401)  # organizer sessions never open the platform console
        admin_mail, admin_pw = secrets.token_hex(5) + '@encore.test', secrets.token_urlsafe(18)
        with s.conn() as con:
            s.os.environ.update(ENCORE_PLATFORM_EMAIL=admin_mail, ENCORE_PLATFORM_PASSWORD=admin_pw)
            try:
                s.bootstrap_platform_admin(con)
            finally:
                s.os.environ.pop('ENCORE_PLATFORM_EMAIL'); s.os.environ.pop('ENCORE_PLATFORM_PASSWORD')
        self.assertEqual(platform('platform/signin', {'email': admin_mail, 'password': 'wrong-password'})[0], 401)
        self.assertEqual(platform('platform/signin', {'email': admin_mail, 'password': admin_pw})[0], 200)
        self.assertEqual(c('me')[0], 200)  # a platform cookie does not grant organizer access, and vice versa

        status, data = platform('platform/data')
        self.assertEqual(status, 200)
        mine = next(t for t in data['tenants'] if t['id'] == tenant)
        self.assertEqual(mine['bookings'][0]['settlement'], 'cash')
        self.assertEqual(mine['team'][0]['email'], mail)
        raw = json.dumps(data)
        for secret_field in ['"token"', '"password"', '"recovery"']:
            self.assertNotIn(secret_field, raw)

        self.assertEqual(platform('platform/tenant/status', {'tenant': tenant, 'status': 'suspended', 'note': ''})[0], 400)
        self.assertEqual(platform('platform/tenant/status', {'tenant': tenant, 'status': 'suspended', 'note': 'Review'})[0], 200)
        self.assertEqual(c('me')[0], 401)  # staff sessions ended
        status, body = Client(self.admin.server_port)('signin', {'email': mail, 'password': pw})
        self.assertEqual((status, body.get('code')), (403, 'TENANT_SUSPENDED'))
        self.assertNotIn(tenant, [w['id'] for w in g('workspaces')[1]])
        self.assertEqual(g('public?tenant=' + tenant)[0], 404)

        self.assertEqual(platform('platform/tenant/status', {'tenant': tenant, 'status': 'active'})[0], 200)
        self.assertEqual(Client(self.admin.server_port)('signin', {'email': mail, 'password': pw})[0], 200)
        self.assertIn(tenant, [w['id'] for w in g('workspaces')[1]])
        actions = [a['action'] for a in platform('platform/data')[1]['platformAudit']]
        self.assertEqual(actions[:3], ['reactivate', 'suspend', 'signin'])
        user_id = mine['team'][0]['id']
        self.assertEqual(Client(self.admin.server_port)('platform/user/reset', {'user': user_id})[0], 401)
        status, reset = platform('platform/user/reset', {'user': user_id})
        self.assertEqual((status, reset['email']), (200, mail))
        new_pw = secrets.token_urlsafe(18)
        anon = Client(self.admin.server_port)
        self.assertEqual(anon('recover', {'email': mail, 'password': new_pw, 'recovery': 'old-or-wrong'})[0], 401)
        self.assertEqual(anon('recover', {'email': mail, 'password': new_pw, 'recovery': reset['recovery']})[0], 200)
        self.assertEqual(anon('signin', {'email': mail, 'password': new_pw})[0], 200)
        self.assertEqual(platform('platform/data')[1]['platformAudit'][0]['action'], 'reset_access')
        platform('platform/signout', {})
        self.assertEqual(platform('platform/data')[0], 401)


class EthiopiaTaxCategoryProfileTests(AppTests):
    def test_tax_categories_and_profile(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c, price='115')
        self.act(c, 'table', {'name': 'T1', 'event': e['id'], 'seats': 2})
        tok = c('me')[1]['state']['tables'][0]['token']
        # TIN is required once tax is on, and must be 10 digits
        self.assertEqual(self.act(c, 'config', {'group': 'tax', 'values': {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '123', 'tickets': True, 'menu': True}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'tax', 'values': {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '0012345678', 'tickets': True, 'menu': True}})[0], 200)
        g, _ = self.guest_client()
        q = g('quote', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2})[1]
        self.assertEqual((q['total'], q['tax']['amount'], q['tax']['label'], q['tin']), (23000, 3000, 'VAT 15%', '0012345678'))  # 230.00 incl. 30.00 VAT
        self.act(c, 'config', {'group': 'tax', 'values': {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': False, 'tin': '0012345678', 'tickets': True, 'menu': True}})
        self.act(c, 'config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}})
        rec = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1, 'payment': 'cash'})[1]
        self.assertEqual((rec['subtotal'], rec['tax']['amount'], rec['total']), (11500, 1725, 13225))  # VAT added on top
        # categories: must exist; rename cascades; removal blocked while in use
        self.assertEqual(self.act(c, 'menu', {'name': 'Tej', 'description': 'Honey wine', 'price': '100', 'category': 'Cocktails', 'available': True})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'menu', 'values': {'categories': ['Food', 'Drinks', 'Cocktails']}})[0], 200)
        self.assertEqual(self.act(c, 'menu', {'name': 'Tej', 'description': 'Honey wine', 'price': '100', 'category': 'cocktails', 'available': True})[0], 200)
        self.assertEqual(self.act(c, 'config', {'group': 'menu', 'values': {'categories': ['Food', 'Drinks']}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'menu', 'values': {'categories': ['Food', 'Drinks', 'Traditional'], 'renames': {'Cocktails': 'Traditional'}}})[0], 200)
        self.assertEqual(c('me')[1]['state']['menu'][0]['category'], 'Traditional')
        # TOT is no longer offered; VAT added on menu orders; a tip amount is added untaxed
        self.assertEqual(self.act(c, 'config', {'group': 'tax', 'values': {'regime': 'tot', 'pricesIncludeTax': False, 'tin': '0012345678', 'tickets': True, 'menu': True}})[0], 400)
        item = c('me')[1]['state']['menu'][0]['id']
        rec = g('order', {'tenant': t, 'kind': 'menu', 'items': {item: 3}, 'tipAmount': '25.50', 'table': tok, 'payment': 'cash'})[1]
        self.assertEqual((rec['subtotal'], rec['tax']['label'], rec['tax']['amount'], rec['tip'], rec['total']), (30000, 'VAT 15%', 4500, 2550, 37050))
        # inclusive VAT with awkward amounts rounds to the nearest cent and never changes the total
        self.act(c, 'config', {'group': 'tax', 'values': {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '0012345678', 'tickets': True, 'menu': True}})
        q = g('quote', {'tenant': t, 'kind': 'menu', 'items': {item: 1}, 'tipAmount': 0, 'table': tok})[1]
        self.assertEqual((q['subtotal'], q['tax']['amount'], q['total']), (10000, 1304, 10000))  # 100.00 incl. 13.04 VAT
        # ratings: only guests who booked or ordered; one rating per guest, updatable; shown in the directory
        stranger, _ = self.guest_client()
        self.assertEqual(stranger('guest/rating', {'tenant': t, 'stars': 5})[0], 401)
        self.assertEqual(g('guest/rating', {'tenant': t, 'stars': 6})[0], 400)
        self.assertEqual(g('guest/rating', {'tenant': t, 'stars': 3, 'comment': 'Good sound'})[1]['average'], 3.0)
        summary = g('guest/rating', {'tenant': t, 'stars': 5, 'comment': 'Great night'})[1]
        self.assertEqual((summary['count'], summary['average'], summary['mine']['stars']), (1, 5.0, 5))
        self.assertEqual(g('public?tenant=' + t)[1]['ratings']['recent'][0]['comment'], 'Great night')
        self.assertEqual(c('me')[1]['ratings']['count'], 1)
        # profile: location and photos appear in the organizer directory
        png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
        url = c('upload', {'data': png})[1]['url']
        self.assertEqual(self.act(c, 'config', {'group': 'profile', 'values': {'city': 'Addis Ababa', 'address': 'Bole Road', 'mapUrl': 'javascript:alert(1)', 'photos': [url]}})[0], 400)
        self.assertEqual(self.act(c, 'config', {'group': 'profile', 'values': {'city': 'Addis Ababa', 'address': 'Bole Road', 'mapUrl': 'https://maps.app.goo.gl/abc123', 'photos': [url]}})[0], 200)
        self.assertEqual(self.act(c, 'config', {'group': 'profile', 'values': {'city': 'Addis Ababa', 'address': 'Bole Road', 'mapUrl': 'https://maps.example/x', 'photos': [url]}})[0], 400)
        self.act(c, 'config', {'group': 'profile', 'values': {'city': 'Addis Ababa', 'address': 'Bole Road', 'mapUrl': '', 'photos': [url]}})
        org = next(w for w in Client(self.guest.server_port)('workspaces')[1] if w['id'] == t)
        self.assertEqual((org['photo'], org['address'], org['city'], org['events'], org['rating']['average']), (url, 'Bole Road', 'Addis Ababa', 1, 5.0))
        self.assertEqual(org['mapLink'], 'https://www.google.com/maps/search/?api=1&query=Bole%20Road%2C%20Addis%20Ababa%2C%20Ethiopia')


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for case in [AppTests, DomainTests, SmsProviderTests]:
        suite.addTests(loader.loadTestsFromTestCase(case))
    suite.addTest(EthiopiaTaxCategoryProfileTests('test_tax_categories_and_profile'))
    return suite


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.state = domain.upgrade(domain.blank('Concert Team'))
        self.state['settings']['ordering']['requireScan'] = False
        self.state['settings']['payments']['ticketCash'] = True
        self.state['settings']['ordering']['ticketHoldersOnly'] = False
        self.state['menu'] = [{'id': 'food', 'name': 'Meal', 'price': 10000, 'available': True, 'events': []}]
        self.state['events'] = [{'id': 'event', 'name': 'Concert', 'price': 50000, 'published': True, 'capacity': 2, 'date': '2026-11-02T18:00'}]
        self.state['tables'] = [{'id': 't', 'token': 'unique-table', 'code': 'ABCDEF', 'name': 'Table 8', 'event': 'event', 'seats': 4, 'status': 'Available'}]

    def test_server_prices_and_table_context(self):
        q = domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 2}, 'table': 'unique-table', 'tipAmount': '30', 'total': 1})
        self.assertEqual((q['total'], q['tip'], q['tableName'], q['tax']['amount'], q['tax']['included']), (26000, 3000, 'Table 8', 3000, False))  # 200 + 30 VAT + 30 tip
        self.assertIsNone(q['fee'])

    def test_existing_workspaces_switch_to_vat_added_on_top_once(self):
        old = domain.blank('Old')
        old['settings']['tax'] = {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '', 'vatNumber': '', 'tickets': True, 'menu': True}
        tax = domain.upgrade(old)['settings']['tax']
        self.assertEqual((tax['pricesIncludeTax'], tax['addedOnTop']), (False, True))
        tax['pricesIncludeTax'] = True  # an organizer who later chooses VAT-inclusive prices keeps that choice
        self.assertTrue(domain.upgrade(old)['settings']['tax']['pricesIncludeTax'])

    def test_reject_unavailable_items_and_bad_table(self):
        for data in [{'kind': 'menu', 'items': {'foreign-id': 1}}, {'kind': 'menu', 'items': {'food': 1}, 'table': 'wrong'},
                     {'kind': 'booking', 'event': 'event', 'qty': 3}, {'kind': 'menu', 'items': {'food': 1.5}}]:
            with self.assertRaises(ValueError):
                domain.quote_order(self.state, data)

    def test_service_charge_is_taxed_and_tips_are_not(self):
        domain.configure(self.state, 'service', {'mode': 'both', 'rate': 10})
        q = domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 1}, 'tipAmount': '5'})
        # 100.00 items + 10.00 service + 15% VAT on 110.00 (16.50) + 5.00 tip = 131.50
        self.assertEqual((q['subtotal'], q['service']['amount'], q['tax']['amount'], q['tip'], q['total']), (10000, 1000, 1650, 500, 13150))
        domain.configure(self.state, 'service', {'mode': 'service', 'rate': 12.5})
        self.assertFalse(self.state['settings']['tips']['enabled'])
        with self.assertRaises(ValueError):
            domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 1}, 'tipAmount': '5'})
        booking = domain.quote_order(self.state, {'kind': 'booking', 'event': 'event', 'qty': 1})
        self.assertIsNone(booking['service'])  # tickets never carry a service charge
        with self.assertRaises(ValueError):
            domain.configure(self.state, 'service', {'mode': 'service', 'rate': 0})
        domain.configure(self.state, 'service', {'mode': 'none', 'rate': 10})
        self.assertEqual(domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 1}})['total'], 11500)

    def test_stock_blocks_overselling_and_cancel_restores(self):
        s = self.state
        domain.mutate(s, 'menu', {'id': 'food', 'name': 'Meal', 'description': 'Hot', 'price': '100', 'category': 'Food', 'available': True, 'trackStock': True, 'stock': 3, 'lowStock': 1}, [])
        guest = {'id': 'g1', 'name': 'Guest', 'phone': '+251911000000'}
        rec = domain.guest_record(s, {'kind': 'menu', 'items': {'food': 2}}, guest, cash=True)
        self.assertEqual((rec['paid'], rec['settlement']), (False, 'cash'))
        self.assertEqual(s['menu'][0]['stock'], 1)
        self.assertEqual(domain.public_state(s)['menu'][0]['left'], 1)
        with self.assertRaisesRegex(ValueError, 'Only 1 Meal left'):
            domain.guest_record(s, {'kind': 'menu', 'items': {'food': 2}}, guest, cash=True)
        self.assertEqual(s['menu'][0]['stock'], 1)
        domain.mutate(s, 'stock', {'id': 'food', 'mode': 'add', 'qty': 10, 'reason': 'Delivery'}, [])
        domain.mutate(s, 'stock', {'id': 'food', 'mode': 'remove', 'qty': 1, 'reason': 'Dropped'}, [])
        domain.mutate(s, 'stock', {'id': 'food', 'mode': 'set', 'qty': 0}, [])
        self.assertTrue(domain.public_state(s)['menu'][0]['soldOut'])
        with self.assertRaises(ValueError):
            domain.mutate(s, 'stock', {'id': 'food', 'mode': 'remove', 'qty': 1}, [])
        domain.mutate(s, 'stock', {'id': 'food', 'mode': 'add', 'qty': 2}, [])
        domain.mutate(s, 'staff_order', staff := {'items': {'food': 2}, 'tableId': 't', 'method': '', '_by': 'Sara'}, [])
        self.assertEqual(s['menu'][0]['stock'], 0)
        unpaid = next(o for o in s['orders'] if o['ref'] == staff['result']['ref'])
        domain.mutate(s, 'cancel', {'id': unpaid['id'], '_by': 'Sara'}, [])
        self.assertEqual(s['menu'][0]['stock'], 2)
        self.assertEqual([x['reason'] for x in s['stockLog']][-1], f'Cancelled {unpaid["ref"]}')
        self.assertEqual(s['stockLog'][0]['reason'], 'Opening count')
        self.assertEqual([x['after'] for x in s['stockLog']], [3, 1, 11, 10, 0, 2, 0, 2])

    def test_waiter_numbers_tips_and_cash_orders(self):
        s = self.state
        for name in ['Abel Tesfaye', 'Sara Bekele', 'Old Waiter']:
            domain.mutate(s, 'waiter', {'name': name}, [])
        numbers = [w['number'] for w in s['waiters']]
        self.assertEqual(len(set(numbers)), 3)
        self.assertTrue(all(re.fullmatch(r'[1-9]\d{3}', n) for n in numbers))
        old = s['waiters'][2]
        domain.mutate(s, 'waiter', {'id': old['id'], 'name': old['name'], 'active': False}, [])
        self.assertTrue(domain.public_state(s)['waiters'])
        with self.assertRaisesRegex(ValueError, 'could not find a waiter'):
            domain.quote_order(s, {'kind': 'menu', 'items': {'food': 1}, 'waiter': old['number']})
        abel = s['waiters'][0]
        q = domain.quote_order(s, {'kind': 'menu', 'items': {'food': 1}, 'tipAmount': '20', 'waiter': f'#{abel["number"]}'})
        self.assertEqual(q['waiter'], {'id': abel['id'], 'name': 'Abel', 'number': abel['number']})
        rec = domain.guest_record(s, {'kind': 'menu', 'items': {'food': 1}, 'tipAmount': '20', 'waiter': abel['number']}, {'id': 'g', 'name': 'G', 'phone': '+251911000001'}, cash=True)
        self.assertEqual((rec['waiter'], rec['waiterName'], rec['tip']), (abel['id'], 'Abel Tesfaye', 2000))
        self.assertNotIn('waiter', domain.receipt(s, rec))  # internal waiter id stays private; name and number are shown
        data = {'items': {'food': 2}, 'tableId': 't', 'waiter': abel['number'], 'tipAmount': '10', 'method': 'Cash', 'name': 'Table guest', '_by': 'Sara'}
        domain.mutate(s, 'staff_order', data, [])
        o = s['orders'][-1]
        self.assertEqual((o['paid'], o['settledBy'], o['takenBy'], o['waiterNumber'], o['total'], o['tableName']), (True, 'Cash', 'Sara', abel['number'], 20000 + 3000 + 1000, 'Table 8'))
        with self.assertRaises(ValueError):
            domain.mutate(s, 'staff_order', {**data, 'method': 'Bank transfer'}, [])
        with self.assertRaisesRegex(ValueError, 'has orders'):
            domain.mutate(s, 'delete', {'kind': 'waiter', 'id': abel['id']}, [])
        before = abel['number']
        domain.mutate(s, 'waiter', {'id': abel['id'], 'name': abel['name'], 'regenerate': True}, [])
        self.assertNotEqual(s['waiters'][0]['number'], before)
        with self.assertRaises(ValueError):
            domain.mutate(s, 'settle', {'id': s['orders'][0]['id'], 'method': 'Bank transfer'}, [])

    def test_store_inventory_items_with_units(self):
        s = self.state
        domain.mutate(s, 'inventory', {'name': 'St. George beer', 'category': 'Alcohol', 'unit': 'bottles', 'quantity': 48, 'reorderLevel': 24, 'cost': '45.50', 'supplier': 'BGI', '_by': 'Owner'}, [])
        domain.mutate(s, 'inventory', {'name': 'Beef', 'category': 'Meat', 'unit': 'kg', 'quantity': '12.5', 'reorderLevel': 5, 'cost': '800'}, [])
        beer, beef = s['inventory']
        self.assertEqual((beer['quantity'], beer['cost'], beef['quantity']), (48, 4550, 12.5))
        with self.assertRaisesRegex(ValueError, 'already in your store'):
            domain.mutate(s, 'inventory', {'name': 'beef', 'category': 'Meat', 'unit': 'kg'}, [])
        with self.assertRaises(ValueError):
            domain.mutate(s, 'inventory', {'name': 'Bread', 'category': 'Bakery', 'unit': 'spoons'}, [])
        domain.mutate(s, 'inventory_adjust', {'id': beef['id'], 'mode': 'use', 'qty': '2.25', 'note': 'Tibs'}, [])
        domain.mutate(s, 'inventory_adjust', {'id': beer['id'], 'mode': 'add', 'qty': 24, 'cost': '47'}, [])
        domain.mutate(s, 'inventory_adjust', {'id': beer['id'], 'mode': 'waste', 'qty': 2}, [])
        with self.assertRaisesRegex(ValueError, 'Only 70 bottles'):
            domain.mutate(s, 'inventory_adjust', {'id': beer['id'], 'mode': 'use', 'qty': 71}, [])
        domain.mutate(s, 'inventory_adjust', {'id': beef['id'], 'mode': 'set', 'qty': 10}, [])
        self.assertEqual((beer['quantity'], beer['cost'], beef['quantity']), (70, 4700, 10))
        store_log = [x for x in s['stockLog'] if x.get('store')]
        self.assertEqual([(x['name'], x['change'], x['after']) for x in store_log], [('St. George beer', 48, 48), ('Beef', 12.5, 12.5), ('Beef', -2.25, 10.25), ('St. George beer', 24, 72), ('St. George beer', -2, 70), ('Beef', -0.25, 10)])
        self.assertEqual(store_log[2]['reason'], 'Used in kitchen/bar · Tibs')
        domain.configure(s, 'store', {'categories': ['Beverages', 'Meat', 'Spices'], 'renames': {'Alcohol': 'Beverages'}})
        self.assertEqual(beer['category'], 'Beverages')
        domain.mutate(s, 'inventory', {'name': 'Berbere', 'category': 'Spices', 'unit': 'kg', 'quantity': 2}, [])
        with self.assertRaisesRegex(ValueError, 'Move stock items out of Meat'):
            domain.configure(s, 'store', {'categories': ['Beverages', 'Spices']})
        domain.mutate(s, 'delete', {'kind': 'inventory', 'id': beef['id']}, [])
        self.assertEqual([i['name'] for i in s['inventory']], ['St. George beer', 'Berbere'])

    def test_guests_can_choose_cash_for_orders(self):
        s = self.state
        guest = {'id': 'g', 'name': 'Guest', 'phone': '+251911000009'}
        rec = domain.guest_record(s, {'kind': 'menu', 'items': {'food': 1}, 'tipAmount': '10'}, guest, cash=True)
        self.assertEqual((rec['paid'], rec['settlement'], rec['total']), (False, 'cash', 12500))
        domain.configure(s, 'payments', {'cash': True, 'ticketCash': False})
        with self.assertRaisesRegex(ValueError, 'online payment for tickets'):
            domain.guest_record(s, {'kind': 'booking', 'event': 'event', 'qty': 1}, guest, cash=True)
        domain.mutate(s, 'settle', {'id': rec['id'], 'method': 'Cash'}, [])
        self.assertEqual((rec['paid'], rec['settledBy']), (True, 'Cash'))
        domain.configure(s, 'payments', {'cash': False, 'ticketCash': False})
        with self.assertRaisesRegex(ValueError, 'only accepts online payment'):
            domain.guest_record(s, {'kind': 'menu', 'items': {'food': 1}}, guest, cash=True)
        with self.assertRaisesRegex(ValueError, 'paid online only'):
            domain.guest_record(s, {'kind': 'menu', 'items': {'food': 1}}, guest)

    def test_phone_normalization(self):
        for raw in ['0911 234 567', '911234567', '+251911234567', '00251 911-234-567']:
            self.assertEqual(domain.normalize_phone(raw), '+251911234567')
        self.assertEqual(domain.normalize_phone('+14155550123'), '+14155550123')
        for bad in ['0811234567', '12345', '']:
            with self.assertRaises(ValueError):
                domain.normalize_phone(bad)


class SmsProviderTests(unittest.TestCase):
    """Providers are checked by capturing the HTTP request instead of contacting the gateway."""

    def setUp(self):
        self.sent = []
        self.reply = b'{"acknowledge": "success"}'
        self.status = 200

        class FakeResponse:
            status = self.status

            def __init__(inner, body):
                inner._body = body

            def read(inner):
                return inner._body

            def __enter__(inner):
                return inner

            def __exit__(inner, *a):
                return False

        def fake_urlopen(request, timeout=None):
            self.sent.append({'url': request.full_url, 'method': request.get_method(),
                              'headers': {k.lower(): v for k, v in request.headers.items()},
                              'body': (request.data or b'').decode()})
            response = FakeResponse(self.reply)
            response.status = self.status
            return response

        self.original = sms.urllib.request.urlopen
        sms.urllib.request.urlopen = fake_urlopen
        self.env = dict(os.environ)

    def tearDown(self):
        sms.urllib.request.urlopen = self.original
        os.environ.clear()
        os.environ.update(self.env)

    def use(self, **env):
        os.environ.update(env)

    def test_twilio_request_and_missing_settings(self):
        self.use(SMS_PROVIDER='twilio', TWILIO_ACCOUNT_SID='AC123', TWILIO_AUTH_TOKEN='secret', TWILIO_FROM='+15550001111')
        self.assertTrue(sms.status()['delivers'])
        self.assertEqual(sms.send('+251911234567', 'Your Encore code is 123456.'), 'twilio')
        call = self.sent[0]
        self.assertEqual(call['url'], 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
        self.assertIn('To=%2B251911234567', call['body'])
        self.assertIn('From=%2B15550001111', call['body'])
        self.assertIn('Body=Your+Encore+code', call['body'])
        self.assertTrue(call['headers']['authorization'].startswith('Basic '))
        del os.environ['TWILIO_FROM']
        self.assertIn('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID', sms.status()['label'])
        with self.assertRaises(sms.NotConfigured):
            sms.send('+251911234567', 'x')

    def test_africastalking_and_afromessage_and_geezsms(self):
        self.use(SMS_PROVIDER='africastalking', AT_USERNAME='encore', AT_API_KEY='key')
        sms.send('+251911234567', 'hello')
        self.assertEqual(self.sent[-1]['url'], 'https://api.africastalking.com/version1/messaging')
        self.assertEqual(self.sent[-1]['headers']['apikey'], 'key')

        self.use(SMS_PROVIDER='afromessage', AFROMESSAGE_TOKEN='tok', AFROMESSAGE_SENDER='Encore')
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'status': 'Send in progress...', 'message_id': 'abc'}}).encode()
        sms.send('+251911234567', 'hello')
        url = urllib.parse.urlparse(self.sent[-1]['url'])
        query = dict(urllib.parse.parse_qsl(url.query))
        self.assertEqual((url.scheme, url.netloc, url.path, self.sent[-1]['method']), ('https', 'api.afromessage.com', '/api/send', 'GET'))
        self.assertEqual(query, {'sender': 'Encore', 'to': '+251911234567', 'message': 'hello'})  # no `from`
        self.assertEqual(self.sent[-1]['headers']['authorization'], 'Bearer tok')

        self.use(SMS_PROVIDER='geezsms', GEEZSMS_TOKEN='tok2')
        sms.send('+251911234567', 'hello')
        self.assertEqual(json.loads(self.sent[-1]['body'])['msg'], 'hello')

    def test_requests_and_replies_are_logged_without_codes(self):
        import io
        from contextlib import redirect_stderr
        self.use(SMS_PROVIDER='afromessage', AFROMESSAGE_TOKEN='tok')
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'code': '778899', 'message_id': 'abc'}}).encode()
        os.environ.pop('SMS_DEBUG', None)
        captured = io.StringIO()
        with redirect_stderr(captured):
            sms.send('+251911234567', 'Your Encore code is 123456.')
        quiet = captured.getvalue()
        self.assertIn('-> GET https://api.afromessage.com/api/send', quiet)
        self.assertIn('<- 200', quiet)
        self.assertIn('acknowledge', quiet)          # the gateway's answer is visible
        self.assertIn('+2519****4567', quiet)        # the number is masked
        self.assertNotIn('123456', quiet)            # the code Encore sent is hidden
        self.assertNotIn('778899', quiet)            # and the code the gateway generated
        self.use(SMS_DEBUG='1')
        loud = io.StringIO()
        with redirect_stderr(loud):
            sms.send('+251911234567', 'Your Encore code is 123456.')
        self.assertIn('123456', loud.getvalue())     # full detail only while debugging
        self.assertIn('778899', loud.getvalue())

    def test_afromessage_reports_failure_and_challenge_codes(self):
        self.use(SMS_PROVIDER='afromessage', AFROMESSAGE_TOKEN='tok', AFROMESSAGE_SENDER='Encore')
        # Anything other than acknowledge: success is a failure, even with HTTP 200.
        self.reply = json.dumps({'acknowledge': 'error', 'response': {'errors': ['invalid recipient']}}).encode()
        with self.assertRaises(sms.DeliveryFailed):
            sms.send('+251911234567', 'hello')
        # Without the challenge endpoint, Encore sends the code it generated itself.
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'message_id': 'abc'}}).encode()
        self.assertEqual(sms.send_signin_code('+251911234567', '123456', 300), ('123456', ''))
        self.assertIn('123456', urllib.parse.unquote(self.sent[-1]['url']))
        # With AFROMESSAGE_CHALLENGE=1 the gateway generates the code and returns a verification id.
        self.use(AFROMESSAGE_CHALLENGE='1', AFROMESSAGE_PREFIX='Your Afropay code is')
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'code': '778899', 'verificationId': 'vid-1', 'message_id': 'xyz'}}).encode()
        self.assertEqual(sms.send_signin_code('+251911234567', '123456', 300), ('778899', 'vid-1'))
        url = urllib.parse.urlparse(self.sent[-1]['url'])
        query = dict(urllib.parse.parse_qsl(url.query))
        self.assertEqual(url.path, '/api/challenge')
        self.assertEqual((query['to'], query['len'], query['ttl'], query['t'], query['sender']),
                         ('+251911234567', '6', '300', '0', 'Encore'))
        self.assertNotIn('from', query)
        self.assertEqual(query['pr'], 'Your Afropay code is')
        # A challenge with neither a code nor a verification id cannot be checked later, so it must fail.
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'message_id': 'xyz'}}).encode()
        with self.assertRaisesRegex(sms.DeliveryFailed, 'neither a verification id nor a code'):
            sms.send_signin_code('+251911234567', '123456', 300)
        # Verification asks /api/verify with the id and the code the guest typed.
        self.reply = json.dumps({'acknowledge': 'success', 'response': {'phone': '+251911234567', 'code': '778899'}}).encode()
        self.assertTrue(sms.verify_signin_code('+251911234567', '778899', 'vid-1'))
        verify = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.sent[-1]['url']).query))
        self.assertEqual(urllib.parse.urlparse(self.sent[-1]['url']).path, '/api/verify')
        self.assertEqual(verify, {'to': '+251911234567', 'code': '778899', 'vc': 'vid-1'})
        self.reply = json.dumps({'acknowledge': 'error', 'response': {'errors': ['code not found']}}).encode()
        self.assertFalse(sms.verify_signin_code('+251911234567', '000000', 'vid-1'))

    def test_requests_carry_a_user_agent_cloudflare_accepts(self):
        # Cloudflare answers the default urllib agent with 403 "error code: 1010".
        self.use(SMS_PROVIDER='afromessage', AFROMESSAGE_TOKEN='tok')
        self.reply = json.dumps({'acknowledge': 'success', 'response': {}}).encode()
        sms.send('+251911234567', 'hello')
        agent = self.sent[-1]['headers']['user-agent']
        self.assertTrue(agent and 'python-urllib' not in agent.lower())
        self.assertEqual(self.sent[-1]['headers']['accept'], 'application/json')

    def test_afromessage_needs_only_a_token_and_defaults_the_sender(self):
        self.use(SMS_PROVIDER='afromessage', AFROMESSAGE_TOKEN='tok')
        os.environ.pop('AFROMESSAGE_SENDER', None)
        self.assertTrue(sms.status()['delivers'])
        sms.send('+251911234567', 'hello')
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.sent[-1]['url']).query))
        self.assertEqual(query['sender'], 'Afropay')          # default when nothing is configured
        self.use(AFROMESSAGE_SENDER='Blue Note')
        sms.send('+251911234567', 'hello')
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.sent[-1]['url']).query))
        self.assertEqual(query['sender'], 'Blue Note')        # an organizer's own name still wins

    def test_afromessage_without_a_token_never_reports_success(self):
        self.use(SMS_PROVIDER='afromessage')
        os.environ.pop('AFROMESSAGE_TOKEN', None)
        self.assertFalse(sms.status()['delivers'])
        self.assertIn('AFROMESSAGE_TOKEN', sms.status()['label'])
        with self.assertRaises(sms.NotConfigured):
            sms.send_signin_code('+251911234567', '123456', 300)
        self.assertEqual(self.sent, [])

    def test_custom_http_gateway_and_error_payloads(self):
        self.use(SMS_PROVIDER='http', SMS_HTTP_URL='https://gateway.example/send', SMS_HTTP_AUTH='Bearer k',
                 SMS_HTTP_BODY='{"number": "{phone}", "content": "{text}"}')
        sms.send('+251911234567', 'Code "123456"')
        payload = json.loads(self.sent[-1]['body'])
        self.assertEqual((payload['number'], payload['content']), ('+251911234567', 'Code "123456"'))
        self.reply = b'{"acknowledge": "error", "response": "invalid sender"}'
        with self.assertRaisesRegex(sms.DeliveryFailed, 'invalid sender'):
            sms.send('+251911234567', 'x')

    def test_unconfigured_provider_never_reports_success(self):
        self.use(SMS_PROVIDER='', ENCORE_ENV='production')
        self.assertFalse(sms.status()['delivers'])
        with self.assertRaises(sms.NotConfigured):
            sms.send('+251911234567', 'x')
        self.assertEqual(self.sent, [])


if __name__ == '__main__':
    unittest.main()
