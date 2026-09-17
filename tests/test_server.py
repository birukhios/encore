import http.client
import json
import re
import secrets
import sys
import tempfile
import threading
import unittest
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
        s.DB = Path(cls.temp.name) / 'test.sqlite'
        s.UPLOADS = Path(cls.temp.name) / 'uploads'
        s._SECRET = None
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
        if not s.db.POSTGRES:
            import sqlite3
            old = Path(self.temp.name) / 'old.sqlite'
            con = sqlite3.connect(old)
            con.execute('CREATE TABLE users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,recovery TEXT NOT NULL,role TEXT NOT NULL)')
            con.execute("INSERT INTO users VALUES('u','t','Old','old@example.com','x','y','Owner')")
            con.commit()
            s.db.migrate(con)
            self.assertEqual(con.execute('SELECT avatar FROM users').fetchone()[0], '')
            s.db.migrate(con)  # idempotent
            con.close()

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
        s.DEMO = True
        self.assertIn('up to 2', g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 3})[1]['error'])
        self.act(c, 'config', {'group': 'ticketing', 'values': {'enabled': False, 'maxPerOrder': 2}})
        self.assertIn('closed', g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[1]['error'])
        s.DEMO = False

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

    def test_demo_mode_simulates_sms_and_payment(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c)
        g = Client(self.guest.server_port)
        self.assertNotIn('demoCode', g('guest/otp', {'phone': '0944000111'})[1])
        s.DEMO = True
        try:
            sent_before = len(SENT)
            out = g('guest/otp', {'phone': '0944000222'})[1]
            self.assertRegex(out['demoCode'], r'^\d{6}$')
            self.assertEqual(len(SENT), sent_before)  # nothing was sent
            status, body = g('guest/verify', {'phone': '0944000222', 'code': out['demoCode'], 'name': 'Demo', 'acceptTerms': True})
            self.assertEqual(status, 200)
            self.assertTrue(g('public?tenant=' + t)[1]['demo'])
            status, rec = g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1, 'paid': False, 'total': 1})
            self.assertEqual((status, rec['paid'], rec['settledBy'], rec['total']), (201, True, 'Demo payment (simulated)', 10000))
        finally:
            s.DEMO = False
        self.assertEqual(g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[1]['code'], 'PAYMENT_NOT_CONFIGURED')

    def test_online_tickets_reference_checkin_and_notifications(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c, capacity=3)
        g, guest = self.guest_client('Guest One')
        venue = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2})
        self.assertEqual((venue[0], venue[1]['error']), (400, 'Tickets are paid online only.'))
        s.DEMO = True
        try:
            status, rec = g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2, 'total': 1, 'paid': False})
            self.assertEqual(status, 201)
            self.assertEqual((rec['total'], rec['paid'], rec['status'], len(rec['tickets']), rec['name']), (20000, True, 'Reserved', 2, 'Guest One'))
            g2, _ = self.guest_client()
            self.assertEqual(g2('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2})[0], 400)  # capacity
        finally:
            s.DEMO = False
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
        self.assertIn('Tickets confirmed', titles)
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
        self.assertIn('Scan', g('order', {'tenant': t, 'kind': 'menu', 'items': tea})[1]['error'])
        self.assertIn('ticket holders', g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'table': tok})[1]['error'])
        s.DEMO = True
        self.assertEqual(g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[0], 201)
        s.DEMO = False
        self.assertIn('not served', g('order', {'tenant': t, 'kind': 'menu', 'items': {menu[1]['id']: 1}, 'table': tok})[1]['error'])
        self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'table': 'forged'})[0], 400)
        self.act(c, 'config', {'group': 'tips', 'values': {'enabled': True, 'presets': [10, 50], 'custom': False}})
        self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'tipAmount': '7', 'table': tok})[0], 400)
        for bad in ['-5', '10.555', 'abc']:
            self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'tipAmount': bad, 'table': tok})[0], 400, bad)
        status, rec = g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'tipAmount': '10', 'table': tok})
        self.assertEqual(status, 201)
        self.assertEqual((rec['subtotal'], rec['tip'], rec['total'], rec['tableName'], rec['status']), (10000, 1000, 11000, 'Table 3', 'Placed'))
        order = c('me')[1]['state']['orders'][0]
        for status_name in ['Preparing', 'Ready', 'Delivered']:
            self.assertEqual(self.act(c, 'order_status', {'id': order['id'], 'status': status_name})[0], 200)
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=' + rec['token'])[1]['status'], 'Delivered')
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=wrong')[0], 404)
        self.assertTrue(any('ready' in msg and phone == guest['phone'] for phone, msg in SENT))


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
        s.DEMO = True
        rec = g('checkout', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[1]
        s.DEMO = False
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
        rec = g('order', {'tenant': t, 'kind': 'menu', 'items': {item: 3}, 'tipAmount': '25.50', 'table': tok})[1]
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
    for case in [AppTests, DomainTests]:
        suite.addTests(loader.loadTestsFromTestCase(case))
    suite.addTest(EthiopiaTaxCategoryProfileTests('test_tax_categories_and_profile'))
    return suite


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.state = domain.upgrade(domain.blank('Concert Team'))
        self.state['settings']['ordering']['requireScan'] = False
        self.state['settings']['ordering']['ticketHoldersOnly'] = False
        self.state['menu'] = [{'id': 'food', 'name': 'Meal', 'price': 10000, 'available': True, 'events': []}]
        self.state['events'] = [{'id': 'event', 'name': 'Concert', 'price': 50000, 'published': True, 'capacity': 2}]
        self.state['tables'] = [{'id': 't', 'token': 'unique-table', 'code': 'ABCDEF', 'name': 'Table 8', 'event': 'event', 'status': 'Available'}]

    def test_server_prices_and_table_context(self):
        q = domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 2}, 'table': 'unique-table', 'tipAmount': '30', 'total': 1})
        self.assertEqual((q['total'], q['tip'], q['tableName'], q['tax']['amount']), (23000, 3000, 'Table 8', 2609))  # VAT 15% included in 200.00
        self.assertIsNone(q['fee'])

    def test_reject_unavailable_items_and_bad_table(self):
        for data in [{'kind': 'menu', 'items': {'foreign-id': 1}}, {'kind': 'menu', 'items': {'food': 1}, 'table': 'wrong'},
                     {'kind': 'booking', 'event': 'event', 'qty': 3}, {'kind': 'menu', 'items': {'food': 1.5}}]:
            with self.assertRaises(ValueError):
                domain.quote_order(self.state, data)

    def test_phone_normalization(self):
        for raw in ['0911 234 567', '911234567', '+251911234567', '00251 911-234-567']:
            self.assertEqual(domain.normalize_phone(raw), '+251911234567')
        self.assertEqual(domain.normalize_phone('+14155550123'), '+14155550123')
        for bad in ['0811234567', '12345', '']:
            with self.assertRaises(ValueError):
                domain.normalize_phone(bad)


if __name__ == '__main__':
    unittest.main()
