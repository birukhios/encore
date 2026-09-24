"""Golden cases that pin the .NET port of domain.py's money rules to the Python originals.

`python3 tests/parity.py` rewrites backend/Encore.Api.Tests/Fixtures/parity.json; the .NET tests replay every
case and must produce the same result or the same message. test_parity_fixture_is_current fails if domain.py
changes without the fixture (and so the port) being brought along.
"""
import copy
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import domain  # noqa: E402

FIXTURE = ROOT / 'backend' / 'Encore.Api.Tests' / 'Fixtures' / 'parity.json'


def outcome(fn, *args, **kwargs):
    try:
        return {'ok': fn(*args, **kwargs)}
    except ValueError as problem:
        return {'error': str(problem)}


def base_workspace():
    s = domain.upgrade(domain.blank('Parity Hall'))
    s['events'] = [
        {'id': 'ev1', 'name': 'Late Set', 'price': 50000, 'published': True, 'capacity': 10, 'date': '2026-11-02T18:00'},
        {'id': 'ev2', 'name': 'Matinee', 'price': 12550, 'published': True, 'capacity': 3, 'date': '2026-11-03T14:00'},
        {'id': 'ev3', 'name': 'Draft Show', 'price': 9900, 'published': False, 'capacity': 50, 'date': '2026-12-01T20:00'},
    ]
    s['tables'] = [
        {'id': 't1', 'token': 'tok-one', 'code': 'ACDEFG', 'name': 'Table 1', 'event': 'ev1', 'seats': 4, 'status': 'Available'},
        {'id': 't2', 'token': 'tok-two', 'code': 'HJKLMN', 'name': 'Table 2', 'event': 'ev2', 'seats': 2, 'status': 'Blocked'},
        {'id': 't3', 'token': 'tok-three', 'code': 'PQRTUV', 'name': 'Table 3', 'event': 'ev3', 'seats': 6, 'status': 'Available'},
    ]
    s['menu'] = [
        {'id': 'm1', 'name': 'Tibs', 'price': 45000, 'available': True, 'events': [], 'trackStock': False},
        {'id': 'm2', 'name': 'Ambo', 'price': 3333, 'available': True, 'events': ['ev1'], 'trackStock': True, 'stock': 5},
        {'id': 'm3', 'name': 'Old dish', 'price': 1000, 'available': False, 'events': []},
        {'id': 'm4', 'name': 'Juice', 'price': 7999, 'available': True, 'events': ['ev2'], 'trackStock': True, 'stock': 0},
    ]
    s['waiters'] = [
        {'id': 'w1', 'name': 'Abel Tesfaye', 'number': '4821', 'active': True},
        {'id': 'w2', 'name': 'Old Waiter', 'number': '5930', 'active': False},
    ]
    s['bookings'] = [
        {'id': 'b1', 'event': 'ev2', 'guest': 'g1', 'qty': 2, 'status': 'Reserved'},
        {'id': 'b2', 'event': 'ev1', 'guest': 'g2', 'qty': 1, 'status': 'Cancelled'},
    ]
    return s


def settings_variants(rng):
    for _ in range(24):
        s = base_workspace()
        c = s['settings']
        c['tax'].update(regime=rng.choice(['vat', 'vat', 'none']), vatRate=rng.choice([15, 15, 12.5, 0, 7.5, 2]),
                        pricesIncludeTax=rng.choice([False, True]), tickets=rng.choice([True, False]),
                        menu=rng.choice([True, True, False]), tin=rng.choice(['', '0012345678']), vatNumber=rng.choice(['', 'V-77']))
        c['service'].update(enabled=rng.choice([False, True]), rate=rng.choice([10, 12.5, 5, 0, 7.75]))
        c['tips'].update(enabled=rng.choice([True, True, False]), custom=rng.choice([True, False]), presets=rng.choice([[20, 50, 100], [10, 25.5]]))
        c['ticketing'].update(enabled=rng.choice([True, True, True, False]), maxPerOrder=rng.choice([6, 2]))
        c['ordering'].update(enabled=rng.choice([True, True, True, False]), requireScan=rng.choice([False, True]),
                             ticketHoldersOnly=rng.choice([False, True]), eventMenus=rng.choice([True, False]))
        yield s


def requests(rng):
    tips = [None, '', '0', '30', '12.34', '0.1', '1.005', '-5', 'abc', 20, 50, 25.5, 1e2, True, '50000', '50000.01', ' 7 ']
    carts = [{'m1': 1}, {'m1': 2, 'm2': 1}, {'m2': 6}, {'m3': 1}, {'m4': 1}, {'m1': 0}, {'m1': 1.5}, {'m1': '2'}, {'nope': 1},
             {}, [], {'m2': 51}, {'m1': True}, {'m1': 1, 'm2': 0}]
    for _ in range(12):
        yield {'kind': 'booking', 'event': rng.choice(['ev1', 'ev2', 'ev3', 'missing']), 'qty': rng.choice([1, 2, 3, 7, 0, '2', 1.5, True, 11])}
    for _ in range(18):
        v = {'kind': 'menu', 'items': copy.deepcopy(rng.choice(carts))}
        if rng.random() < .6:
            v['table'] = rng.choice(['tok-one', 'tok-two', 'tok-three', 'bogus'])
        tip = rng.choice(tips)
        if tip is not None:
            v['tipAmount'] = tip
        if rng.random() < .4:
            v['waiter'] = rng.choice(['4821', '#4821', '5930', '0000', '', 4821])
        v['total'] = 1  # a price the browser invents must be ignored
        yield v
    yield {'kind': 'refund'}


class Script:
    """Deterministic ids, codes, random numbers and clock, mirrored by Ids.Script in the .NET tests."""

    def __init__(self):
        self.uid = self.code = self.below = 0

    def next_uid(self):
        self.uid += 1
        return f'uid{self.uid:04d}'

    def next_code(self, n=6):
        self.code += 1
        return f'C{self.code:05d}'

    def randbelow(self, n):
        value = self.below % n
        self.below += 1
        return value


class scripted:
    def __enter__(self):
        self.script = Script()
        self.saved = domain.uid, domain.short_code, domain.secrets, domain.time
        domain.uid, domain.short_code = self.script.next_uid, self.script.next_code
        domain.secrets = type('S', (), {'randbelow': staticmethod(self.script.randbelow)})
        domain.time = type('T', (), {'time': staticmethod(lambda: 1790000000.25)})
        return self.script

    def __exit__(self, *exc):
        domain.uid, domain.short_code, domain.secrets, domain.time = self.saved


def random_step(rng, s):
    """One staff action or guest order with plausible (and sometimes wrong) data for the current workspace."""
    ids = lambda key: [x['id'] for x in s[key]] + ['missing']
    pick = lambda key: rng.choice([x['id'] for x in s[key]]) if s[key] and rng.random() < .9 else 'missing'
    ORDER_NEXT = {'Placed': 'Preparing', 'Preparing': 'Ready', 'Ready': 'Delivered'}
    records = [r['id'] for r in s['orders'] + s['bookings']] + ['missing']
    money = ['100', '10.50', '0', '-3', 'abc', 99.999, 45, '1e3', True, None]
    op = rng.choice(['event', 'menu', 'table', 'delete', 'order_status', 'order_status', 'settle', 'settle', 'cancel', 'checkin',
                     'checkin_ticket', 'checkin_ticket', 'waiter', 'stock', 'stock', 'inventory', 'inventory_adjust', 'staff_order',
                     'staff_order', 'guest', 'guest', 'guest', 'guest', 'config', 'settings'])
    if op == 'event':
        return op, {'id': rng.choice([None, None, pick('events')]), 'name': rng.choice(['Late Set', '', 'Jazz Night']),
                    'description': 'Live', 'date': rng.choice(['2026-11-02T18:00', '2026-12-01T20:30', 'soon']), 'venue': 'Hall',
                    'price': rng.choice(money), 'capacity': rng.choice([2, 5, 0, '3', 1.5, 100]), 'published': rng.choice([True, False, 'on'])}
    if op == 'menu':
        return op, {'id': rng.choice([None, None, pick('menu')]), 'name': rng.choice(['Tibs', 'Ambo', 'Tej']), 'description': 'Good',
                    'price': rng.choice(money), 'category': rng.choice(['Food', 'drinks', 'Cocktails']), 'available': rng.choice([True, False]),
                    'events': rng.choice([[], [pick('events')], ['missing'], 'x']), 'trackStock': rng.choice([True, False]),
                    'stock': rng.choice([0, 3, 10, -1, '4']), 'lowStock': rng.choice([None, 2, 5])}
    if op == 'table':
        t = rng.choice(s['tables'] + [None, None])
        return op, {'id': t['id'] if t else None, 'name': rng.choice(['Table 1', 'VIP']), 'event': t['event'] if t and rng.random() < .8 else pick('events'),
                    'seats': rng.choice([2, 4, 0, 31]), 'status': rng.choice(['Available', 'Blocked', 'Reserved', 'Broken'])}
    if op == 'delete':
        kind = rng.choice(['event', 'menu', 'table', 'waiter', 'inventory', 'booking'])
        key = {'event': 'events', 'menu': 'menu', 'table': 'tables', 'waiter': 'waiters', 'inventory': 'inventory', 'booking': 'bookings'}[kind]
        return op, {'kind': kind, 'id': pick(key)}
    if op == 'order_status':
        o = rng.choice(s['orders'] + [None])
        wanted = ORDER_NEXT.get(o['status']) if o and rng.random() < .8 else rng.choice(['Preparing', 'Ready', 'Delivered', 'Placed'])
        return op, {'id': o['id'] if o else 'missing', 'status': wanted}
    if op in ('settle', 'cancel'):
        unpaid = [r['id'] for r in s['orders'] + s['bookings'] if not r.get('paid') and r.get('status') != 'Cancelled']
        return op, {'id': rng.choice(unpaid) if unpaid and rng.random() < .8 else rng.choice(records), **({'method': rng.choice(['Cash', 'Card at venue', 'Bank transfer'])} if op == 'settle' and rng.random() < .8 else {})}
    if op == 'checkin':
        paid = [b['id'] for b in s['bookings'] if b.get('paid')]
        return op, {'id': rng.choice(paid) if paid and rng.random() < .8 else pick('bookings')}
    if op == 'checkin_ticket':
        paid = [b for b in s['bookings'] if b.get('paid')]
        b = rng.choice(paid) if paid and rng.random() < .8 else rng.choice(s['bookings'] + [None])
        if b and rng.random() < .5:
            t = rng.choice(b['tickets'])
            return op, {'code': f'{b["ref"]}:{t["serial"]}:{t["token"] if rng.random() < .8 else "forged"}'}
        return op, {'code': rng.choice([b['ref'] if b else 'EN-NONE', (b['ref'][3:].lower() if b else 'zz'), ' '])}
    if op == 'waiter':
        w = rng.choice(s['waiters'] + [None])
        return op, {'id': w['id'] if w else None, 'name': rng.choice(['Abel Tesfaye', 'Sara', '']), 'active': rng.choice([True, False]),
                    'regenerate': rng.random() < .3, 'phone': '0911'}
    if op == 'stock':
        tracked = [i['id'] for i in s['menu'] if i.get('trackStock')]
        return op, {'id': rng.choice(tracked) if tracked and rng.random() < .85 else pick('menu'), 'mode': rng.choice(['add', 'remove', 'set', 'eat']), 'qty': rng.choice([0, 1, 2, 5, 1.5]), 'reason': rng.choice(['', 'Delivery'])}
    if op == 'inventory':
        return op, {'id': rng.choice([None, None, pick('inventory')]), 'name': rng.choice(['Beer', 'Beef', 'beer', 'Bread']),
                    'category': rng.choice(['Alcohol', 'Meat', 'Spices']), 'unit': rng.choice(['bottles', 'kg', 'spoons']),
                    'quantity': rng.choice([0, 12.5, '48', -1]), 'reorderLevel': rng.choice([0, 5, '']), 'cost': rng.choice(['45.50', '800', '1.005', ''])}
    if op == 'inventory_adjust':
        return op, {'id': pick('inventory'), 'mode': rng.choice(['add', 'use', 'waste', 'set', 'eat']), 'qty': rng.choice([0, 1, 2.25, 100, '3']),
                    'note': rng.choice(['', 'Tibs']), **({'cost': rng.choice(['47', 'x', ''])} if rng.random() < .3 else {})}
    if op == 'staff_order':
        return op, {'items': {pick('menu'): rng.choice([1, 2, 0])}, 'tableId': rng.choice([None, pick('tables')]),
                    'method': rng.choice(['', 'Cash', 'Card at venue', 'Bank transfer']), 'tipAmount': rng.choice(['0', '10', '']),
                    'waiter': rng.choice([None, *(w['number'] for w in s['waiters'])]), 'name': rng.choice(['', 'Table guest'])}
    if op == 'config':
        group, values = rng.choice([
            ('payments', {'cash': True, 'ticketCash': True}), ('payments', {'cash': False, 'ticketCash': False}),
            ('service', {'mode': rng.choice(['both', 'service', 'tips', 'none', 'x']), 'rate': rng.choice([10, 12.5, 0, 31])}),
            ('tips', {'enabled': True, 'presets': rng.choice([[10, 50], '5, 10 20', [0], [1, 2, 3, 4, 5, 6]]), 'custom': rng.choice([True, False])}),
            ('tax', {'regime': rng.choice(['vat', 'none', 'tot']), 'vatRate': rng.choice([15, 7.5, 60]), 'pricesIncludeTax': rng.choice([True, False]),
                     'tin': rng.choice(['0012345678', '123', '']), 'tickets': True, 'menu': rng.choice([True, False])}),
            ('ordering', {'enabled': True, 'requireScan': rng.choice([True, False]), 'ticketHoldersOnly': rng.choice([True, False]), 'eventMenus': True}),
            ('ticketing', {'enabled': rng.choice([True, False]), 'maxPerOrder': rng.choice([1, 6, 21]), 'showRemaining': rng.choice([True, False])}),
            ('menu', {'categories': rng.choice([['Food', 'Drinks'], ['Food', 'Drinks', 'Cocktails'], ['Food', 'food'], []]),
                      'renames': rng.choice([{}, {'Drinks': 'Beverages'}])}),
            ('store', {'categories': rng.choice([['Alcohol', 'Meat'], ['Beverages', 'Meat', 'Spices']]), 'renames': rng.choice([{}, {'Alcohol': 'Beverages'}])}),
            ('theme', {'accent': rng.choice(['#1A4DB3', '#FFEEEE', 'red', '#e61e32']), 'mode': rng.choice(['dark', 'light', 'dusk']),
                       'adminMode': rng.choice(['dark', 'system']), 'logo': rng.choice(['', '/uploads/abc.png', 'https://x.test/a.png'])}),
            ('support', {'email': rng.choice(['help@example.com', 'bad']), 'faq': rng.choice([[{'q': 'Parking?', 'a': 'Free.'}], [{'q': 'Q only'}], 'x'])}),
            ('profile', {'city': 'Addis Ababa', 'address': 'Bole Road', 'mapUrl': rng.choice(['', 'https://maps.app.goo.gl/abc', 'https://maps.example/x', 'javascript:x']),
                         'photos': rng.choice([[], ['/uploads/abc.png'], ['https://evil.test/x.png']])}),
            ('notifications', {'smsBookings': rng.choice([True, False]), 'smsOrderReady': True, 'staffNewOrders': True}),
            ('legal', {'terms': 'Be kind.', 'privacy': ''}),
            ('nonsense', {}),
        ])
        return op, {'group': group, 'values': values}
    if op == 'settings':
        return op, {'name': rng.choice(['Blue Note', '']), 'description': 'Live music', 'currency': rng.choice(['ETB', 'USD', 'XXX'])}
    guest = rng.choice([{'id': 'g1', 'name': 'Guest One', 'phone': '+251911000001'}, {'id': 'g2', 'name': 'Sara Bekele', 'phone': '+251911000002'}])
    tables = [t['token'] for t in s['tables']] + ['forged']
    if rng.random() < .45:
        v = {'kind': 'booking', 'event': pick('events'), 'qty': rng.choice([1, 2, 3, 7])}
    else:
        v = {'kind': 'menu', 'items': {pick('menu'): rng.choice([1, 2, 3])}, 'tipAmount': rng.choice(['', '10', '20', '7.5']),
             **({'table': rng.choice(tables)} if rng.random() < .6 else {}),
             **({'waiter': rng.choice([w['number'] for w in s['waiters']] + ['0000'])} if s['waiters'] and rng.random() < .4 else {})}
    return 'guest', {'request': v, 'guest': guest, 'cash': rng.random() < .9}


SETUP = [
    ('config', {'group': 'payments', 'values': {'cash': True, 'ticketCash': True}}),
    ('config', {'group': 'ordering', 'values': {'enabled': True, 'requireScan': False, 'ticketHoldersOnly': False, 'eventMenus': True}}),
    ('event', {'name': 'Late Set', 'description': 'Live', 'date': '2026-11-02T18:00', 'venue': 'Hall', 'price': '100', 'capacity': 6, 'published': True}),
    ('event', {'name': 'Matinee', 'description': 'Early', 'date': '2026-11-01T14:00', 'venue': 'Hall', 'price': '10.50', 'capacity': 3, 'published': True}),
    ('menu', {'name': 'Tibs', 'description': 'Hot', 'price': '450', 'category': 'Food', 'available': True, 'trackStock': True, 'stock': 4, 'lowStock': 2}),
    ('menu', {'name': 'Ambo', 'description': 'Cold', 'price': '33.33', 'category': 'Drinks', 'available': True}),
    ('waiter', {'name': 'Abel Tesfaye'}),
    ('inventory', {'name': 'St. George beer', 'category': 'Alcohol', 'unit': 'bottles', 'quantity': 48, 'reorderLevel': 24, 'cost': '45.50', 'supplier': 'BGI'}),
]


def scenario(rng, n):
    with scripted():
        s = domain.upgrade(domain.blank(f'Scenario {n}'))
        start = copy.deepcopy(s)
        steps = []
        plan = [(op, copy.deepcopy(data)) for op, data in SETUP]
        for i in range(60):
            if i < len(plan):
                op, data = plan[i]
            else:
                op, data = random_step(rng, s)
                # tables need events; add one early so table steps can succeed
                if i == len(plan) and s['events']:
                    op, data = 'table', {'name': 'Table 1', 'event': s['events'][0]['id'], 'seats': 4}
            before = copy.deepcopy(s)
            step = {'op': op, 'data': copy.deepcopy(data), 'by': 'Sara' if rng.random() < .5 else None}
            try:
                if op == 'guest':
                    rec = domain.guest_record(s, copy.deepcopy(data['request']), data['guest'], cash=data['cash'])
                    step['expect'] = {'ok': {'receipt': domain.receipt(s, rec)}}
                else:
                    work = copy.deepcopy(data)
                    if step['by'] and isinstance(work, dict):
                        work['_by'] = step['by']
                    notices = []
                    domain.mutate(s, op, work, notices)
                    step['expect'] = {'ok': {'result': work.get('result') if isinstance(work, dict) else None,
                                             'notices': [{'ref': n['record'].get('ref'), 'kind': n['kind'], 'title': n['title'], 'body': n['body']} for n in notices]}}
            except ValueError as problem:
                s = before  # the server never saves a workspace whose action failed
                step['expect'] = {'error': str(problem)}
            except (KeyError, TypeError, AttributeError) as crash:
                # domain.py crashed; the Python server answered 400 "Invalid request." and saved nothing.
                # The port must also refuse, with a clearer message of its own.
                s = before
                step['expect'] = {'error': None, 'pythonCrash': type(crash).__name__}
            steps.append(step)
        views = {'public': domain.public_state(s), 'receipts': [domain.receipt(s, r) for r in s['orders'] + s['bookings']]}
        return {'start': start, 'steps': steps, 'final': s, 'views': views}


def upgrades():
    old = domain.blank('Old')
    old['settings'] = {'tax': {'regime': 'tot', 'vatRate': 2, 'pricesIncludeTax': True, 'totRate': 2}, 'tips': {'unit': 'percent', 'presets': [5, 10]}}
    old['menu'] = [{'id': 'm', 'name': 'Tea', 'price': 100, 'category': 'Hot drinks', 'available': True}]
    old['inventory'] = [{'id': 'i', 'name': 'Beans', 'category': 'Coffee', 'unit': 'kg', 'quantity': 2}]
    old['tables'] = [{'id': 't', 'token': 'x', 'name': 'T', 'event': 'e', 'seats': 2, 'status': 'Available'}]
    vat = domain.blank('Vat')
    vat['settings']['tax'] = {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '', 'vatNumber': '', 'tickets': True, 'menu': True}
    out = []
    for doc in (old, vat):
        with scripted():
            out.append({'input': copy.deepcopy(doc), 'expect': domain.upgrade(copy.deepcopy(doc))})
    return out


def build():
    rng = random.Random(20260924)
    quotes = []
    for s in settings_variants(rng):
        for v in requests(rng):
            guest = rng.choice([None, 'g1', 'g2'])
            staff = rng.random() < .15
            if staff and v.get('kind') == 'menu' and rng.random() < .5:
                v = {**v, 'tableId': rng.choice(['t1', 't2', 'zz'])}
            quotes.append({'workspace': s, 'request': v, 'guest': guest, 'staff': staff,
                           'expect': outcome(domain.quote_order, copy.deepcopy(s), copy.deepcopy(v), guest, staff)})
        # The same money settings with ordering open, so every tax/service/tip mix is actually priced.
        open_ = copy.deepcopy(s)
        open_['settings']['ordering'].update(enabled=True, requireScan=False, ticketHoldersOnly=False)
        open_['settings']['ticketing']['enabled'] = True
        happy = [{'kind': 'menu', 'items': {'m1': 1}}, {'kind': 'menu', 'items': {'m1': 3, 'm2': 2}, 'table': 'tok-one'},
                 {'kind': 'menu', 'items': {'m2': 1}, 'tipAmount': '20', 'waiter': '4821'},
                 {'kind': 'menu', 'items': {'m1': 1, 'm2': 5}, 'tipAmount': rng.choice(['10', '25.5', '50', '7.77'])},
                 {'kind': 'booking', 'event': 'ev1', 'qty': rng.choice([1, 2])}, {'kind': 'booking', 'event': 'ev2', 'qty': 1}]
        for v in happy:
            quotes.append({'workspace': open_, 'request': v, 'guest': None, 'staff': False,
                           'expect': outcome(domain.quote_order, copy.deepcopy(open_), copy.deepcopy(v))})
    money = ['', None, '0', '5', '5.5', '5.55', '5.555', '-1', '1e2', '1E-2', ' 12 ', 'abc', 'NaN', 'Infinity', True, 0.1, 3, '99999.99', '100000']
    wholes = ['3', 3, 3.0, 3.5, '3.5', 'x', True, -1, 51, '1e1', ' 4 ', 'inf', 'nan']
    phones = ['0911 234 567', '911234567', '+251911234567', '00251 911-234-567', '+14155550123', '0811234567', '12345', '', 7,
              '0711234567', '(091) 123-4567', '+251911234567\n']
    emails = ['A@B.co', ' x@y.z ', 'bad', 'a@b', '', None, 'a b@c.d', 'x@y.z\n']
    return {
        'scenarios': [scenario(rng, n) for n in range(30)],
        'upgrades': upgrades(),
        'quotes': quotes,
        'money': [{'input': m, 'expect': outcome(domain.money_cents, m, 10_000_000, 'Bad amount.')} for m in money],
        'whole': [{'input': w, 'expect': outcome(domain.whole, w, 0, 50, 'Whole only.')} for w in wholes],
        'phones': [{'input': p, 'expect': outcome(domain.normalize_phone, p)} for p in phones],
        'emails': [{'input': e, 'expect': outcome(domain.email, e, False)} for e in emails],
    }


def render():
    return json.dumps(build(), indent=1, sort_keys=True, allow_nan=False) + '\n'


if __name__ == '__main__':
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(render(), encoding='utf-8')
    data = json.loads(FIXTURE.read_text())
    print(f'Wrote {FIXTURE.relative_to(ROOT)}: {len(data["quotes"])} quotes, '
          f'{sum(1 for q in data["quotes"] if "ok" in q["expect"])} priced, the rest refused with a message.')
