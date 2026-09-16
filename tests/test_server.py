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
        self.assertEqual(g('guest/otp', {'phone': phone})[0], 200)
        code = re.search(r'\b(\d{6})\b', SENT[-1][1]).group(1)
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
        self.assertEqual(g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 3})[0], 400)
        self.act(c, 'config', {'group': 'ticketing', 'values': {'enabled': False, 'maxPerOrder': 2}})
        self.assertEqual(g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[0], 400)

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

    def test_booking_tickets_settlement_checkin_and_notifications(self):
        c, b, _, _ = self.staff()
        t = b['user']['tenant']
        e = self.concert(c, capacity=3)
        g, guest = self.guest_client('Guest One')
        status, rec = g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2, 'total': 1, 'paid': True})
        self.assertEqual(status, 201)
        self.assertEqual((rec['total'], rec['paid'], rec['status'], len(rec['tickets']), rec['name']), (20000, False, 'Reserved', 2, 'Guest One'))
        g2, _ = self.guest_client()
        self.assertEqual(g2('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 2})[0], 400)
        self.assertEqual(g2('guest/records?tenant=' + t)[1]['records'], [])
        self.assertEqual(g('guest/records?tenant=' + t)[1]['events'], [e['id']])
        booking = c('me')[1]['state']['bookings'][0]
        self.assertEqual(self.act(c, 'checkin', {'id': booking['id']})[0], 400)
        self.assertEqual(self.act(c, 'settle', {'id': booking['id'], 'method': 'Cash'})[0], 200)
        ticket = rec['tickets'][0]
        status, body = self.act(c, 'checkin_ticket', {'code': f'{rec["ref"]}:1:{ticket["token"]}'})
        self.assertEqual((status, body['result']['serial']), (200, 1))
        self.assertEqual(self.act(c, 'checkin_ticket', {'code': f'{rec["ref"]}:1:{ticket["token"]}'})[0], 400)
        self.assertEqual(self.act(c, 'checkin', {'id': booking['id']})[0], 200)
        self.assertEqual(c('me')[1]['state']['bookings'][0]['status'], 'Checked in')
        other, _, _, _ = self.staff()
        self.assertEqual(self.act(other, 'settle', {'id': booking['id'], 'method': 'Cash'})[0], 400)
        titles = [n['title'] for n in g('guest/notifications')[1]]
        self.assertIn('Tickets reserved', titles)
        self.assertIn('Welcome in!', titles)
        self.assertTrue(any('New booking' in n['title'] for n in c('notifications')[1]))
        self.assertTrue(any(phone == guest['phone'] and 'Pay at the entrance' in msg for phone, msg in SENT))

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
        self.assertEqual(g('order', {'tenant': t, 'kind': 'booking', 'event': e['id'], 'qty': 1})[0], 201)
        self.assertIn('not served', g('order', {'tenant': t, 'kind': 'menu', 'items': {menu[1]['id']: 1}, 'table': tok})[1]['error'])
        self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'table': 'forged'})[0], 400)
        self.act(c, 'config', {'group': 'tips', 'values': {'enabled': True, 'presets': [10], 'custom': False}})
        self.assertEqual(g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'tip': 7, 'table': tok})[0], 400)
        status, rec = g('order', {'tenant': t, 'kind': 'menu', 'items': tea, 'tip': 10, 'table': tok})
        self.assertEqual(status, 201)
        self.assertEqual((rec['subtotal'], rec['tip'], rec['total'], rec['tableName'], rec['status']), (10000, 1000, 11000, 'Table 3', 'Placed'))
        order = c('me')[1]['state']['orders'][0]
        for status_name in ['Preparing', 'Ready', 'Delivered']:
            self.assertEqual(self.act(c, 'order_status', {'id': order['id'], 'status': status_name})[0], 200)
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=' + rec['token'])[1]['status'], 'Delivered')
        self.assertEqual(g('receipt?tenant=' + t + '&ref=' + rec['ref'] + '&token=wrong')[0], 404)
        self.assertTrue(any('ready' in msg and phone == guest['phone'] for phone, msg in SENT))


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.state = domain.upgrade(domain.blank('Concert Team'))
        self.state['settings']['ordering']['requireScan'] = False
        self.state['settings']['ordering']['ticketHoldersOnly'] = False
        self.state['menu'] = [{'id': 'food', 'name': 'Meal', 'price': 10000, 'available': True, 'events': []}]
        self.state['events'] = [{'id': 'event', 'name': 'Concert', 'price': 50000, 'published': True, 'capacity': 2}]
        self.state['tables'] = [{'id': 't', 'token': 'unique-table', 'code': 'ABCDEF', 'name': 'Table 8', 'event': 'event', 'status': 'Available'}]

    def test_server_prices_and_table_context(self):
        q = domain.quote_order(self.state, {'kind': 'menu', 'items': {'food': 2}, 'table': 'unique-table', 'tip': 15, 'total': 1})
        self.assertEqual((q['total'], q['tip'], q['tableName']), (23000, 3000, 'Table 8'))
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
