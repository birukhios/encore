"""Regression tests for account, tenant, media and venue journeys."""
import secrets
import unittest
from concurrent.futures import ThreadPoolExecutor

import server as s
import test_server
from test_server import Client


class JourneyTests(test_server.AppTests):
    """Reuses the two-app server harness from test_server; only the journeys below run here."""

    def catalog(self, capacity=2):
        c, b, _, _ = self.staff()
        e = self.concert(c, capacity=capacity, price='10.50')
        return b, c, e

    def test_profile_password_and_session_revocation(self):
        c, _, mail, pw = self.staff()
        self.assertEqual(c('profile', {'name': 'Updated'})[1]['user']['name'], 'Updated')
        second = Client(self.admin.server_port)
        self.assertEqual(second('signin', {'email': mail, 'password': pw})[0], 200)
        new = secrets.token_urlsafe(24)
        stale = dict(c.cookies)
        self.assertEqual(c('password', {'current': pw, 'password': new})[0], 200)
        c.cookies = stale
        for client in [c, second]:
            self.assertEqual(client('me')[0], 401)
        self.assertEqual(Client(self.admin.server_port)('signin', {'email': mail, 'password': new})[0], 200)

    def test_table_tokens_unique_stable_and_concert_bound(self):
        _, c, e = self.catalog()
        for n in range(2):
            self.act(c, 'table', {'name': f'Table {n}', 'event': e['id'], 'seats': 4})
        tables = c('me')[1]['state']['tables']
        self.assertNotEqual(tables[0]['token'], tables[1]['token'])
        t = tables[0]
        self.assertEqual(self.act(c, 'table', {**t, 'name': 'Renamed'})[0], 200)
        renamed = c('me')[1]['state']['tables'][0]
        self.assertEqual((renamed['token'], renamed['code']), (t['token'], t['code']))
        self.assertEqual(self.act(c, 'table', {**t, 'event': 'other'})[0], 400)

    def test_media_upload_and_foreign_catalog_id(self):
        _, c, e = self.catalog()
        other, _, _, _ = self.staff()
        png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
        status, body = c('upload', {'data': png})
        self.assertEqual(status, 200)
        import base64, http.client
        for port in [self.admin.server_port, self.guest.server_port]:
            conn = http.client.HTTPConnection('127.0.0.1', port)
            conn.request('GET', body['url'])
            resp = conn.getresponse()
            self.assertEqual((resp.status, resp.getheader('Content-Type'), resp.read()), (200, 'image/png', base64.b64decode(png)))
            conn.close()
        self.assertEqual(self.act(other, 'event', e)[0], 400)
        self.assertEqual(self.act(other, 'menu', {'name': 'X', 'description': 'X', 'price': '1', 'category': 'X', 'available': True, 'events': [e['id']]})[0], 400)
        self.assertEqual(other('me')[1]['state']['events'], [])

    def test_non_object_request_is_rejected(self):
        self.assertEqual(Client(self.admin.server_port)('signup', [])[0], 400)
        self.assertEqual(Client(self.guest.server_port)('guest/otp', [])[0], 400)

    def test_online_booking_capacity_and_receipt(self):
        b, c, e = self.catalog()
        tenant = b['user']['tenant']
        g, _ = self.guest_client()
        payload = {'tenant': tenant, 'kind': 'booking', 'event': e['id'], 'qty': 2, 'paid': False, 'total': 1}
        s.DEMO = True
        try:
            self.assertEqual(Client(self.guest.server_port)('checkout', payload)[0], 401)
            status, rec = g('checkout', payload)
            self.assertEqual(status, 201)
            self.assertEqual((rec['total'], rec['paid']), (2100, True))
            self.assertEqual(g('checkout', payload)[0], 400)  # sold out
        finally:
            s.DEMO = False
        path = 'receipt?tenant=' + tenant + '&ref=' + rec['ref'] + '&token='
        self.assertEqual(g(path + 'wrong')[0], 404)
        self.assertEqual(Client(self.guest.server_port)(path + rec['token'])[0], 200)

    def test_concurrent_booking_never_oversells(self):
        b, _, e = self.catalog()
        guests = [self.guest_client()[0] for _ in range(2)]
        p = {'tenant': b['user']['tenant'], 'kind': 'booking', 'event': e['id'], 'qty': 2}
        s.DEMO = True
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                statuses = list(pool.map(lambda g: g('checkout', p)[0], guests))
        finally:
            s.DEMO = False
        self.assertEqual(sorted(statuses), [201, 400])


def load_tests(loader, tests, pattern):
    # Run only the journeys defined here, not the inherited AppTests methods a second time.
    names = [n for n in vars(JourneyTests) if n.startswith('test_')]
    return unittest.TestSuite(JourneyTests(n) for n in names)


if __name__ == '__main__':
    unittest.main()
