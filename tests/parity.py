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
