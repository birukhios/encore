"""Workspace business rules: settings, catalog edits, pricing and guest records.

Workspace state is a JSON document per tenant. Every function here operates on that document
and raises ValueError with a guest- or staff-readable message when a rule is violated.
Nothing in this module trusts client-supplied prices, totals or payment state.
"""
import copy
import hmac
import re
import secrets
import time
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from urllib.parse import quote

CURRENCIES = ['ETB', 'USD', 'EUR', 'KES', 'NGN', 'GHS', 'RWF', 'UGX']
SETTLEMENT_METHODS = ['Cash', 'Card at venue', 'Bank transfer']
ORDER_FLOW = {'Placed': 'Preparing', 'Preparing': 'Ready', 'Ready': 'Delivered'}
HOLDING_STATUSES = ['Reserved', 'Checked in']  # bookings that consume capacity
CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3469'

DEFAULT_SETTINGS = {
    'theme': {'accent': '#E61E32', 'mode': 'light', 'adminMode': 'light', 'logo': '', 'cover': ''},
    'ticketing': {'enabled': True, 'maxPerOrder': 6, 'showRemaining': False},
    'ordering': {'enabled': True, 'requireScan': True, 'ticketHoldersOnly': True, 'eventMenus': True},
    'tips': {'enabled': True, 'unit': 'amount', 'presets': [20, 50, 100], 'custom': True},
    'payments': {'venue': True},
    'notifications': {'smsBookings': True, 'smsOrderReady': True, 'staffNewOrders': True},
    'support': {'email': '', 'phone': '', 'hours': '', 'faq': []},
    'legal': {'terms': '', 'privacy': ''},
    # Organization profile shown to guests: location and a photo gallery.
    'profile': {'city': 'Addis Ababa', 'address': '', 'mapUrl': '', 'photos': []},
    'menu': {'categories': ['Food', 'Drinks']},
    # Ethiopian VAT: 15% standard rate for VAT-registered businesses. Organizers confirm their own obligations.
    'tax': {'regime': 'vat', 'vatRate': 15, 'pricesIncludeTax': True, 'tin': '', 'vatNumber': '', 'tickets': True, 'menu': True},
}
TAX_REGIMES = ['vat', 'none']
MAX_TIP_CENTS = 5_000_000  # 50,000 in the workspace currency


def uid():
    return secrets.token_urlsafe(18)


def short_code(n=6):
    return ''.join(secrets.choice(CODE_ALPHABET) for _ in range(n))


# ---------------------------------------------------------------- validation helpers

def text(v, maxlen=200, required=True):
    if v is None or (isinstance(v, str) and not v.strip()):
        if required:
            raise ValueError('Please complete all required fields.')
        return ''
    if not isinstance(v, str) or len(v) > maxlen:
        raise ValueError('Please complete all required fields.' if not isinstance(v, str) else f'Keep this under {maxlen} characters.')
    return v.strip()


def email(v, required=True):
    v = text(v, 200, required).lower()
    if v and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', v):
        raise ValueError('Enter a valid email address.')
    return v


def number(v, low=0, high=1000000):
    if isinstance(v, bool):
        raise ValueError('Invalid number.')
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ValueError('Enter a valid number.')
    if not low <= n <= high:
        raise ValueError('Number is outside the allowed range.')
    return n


def money_cents(v, max_cents, message):
    """Parse an amount in currency units into exact integer cents (at most 2 decimals, never negative)."""
    if v in (None, ''):
        return 0
    if isinstance(v, bool):
        raise ValueError(message)
    try:
        amount = Decimal(str(v))
    except InvalidOperation:
        raise ValueError(message)
    cents = amount * 100
    if not amount.is_finite() or amount < 0 or cents != cents.to_integral_value() or cents > max_cents:
        raise ValueError(message)
    return int(cents)


def whole(v, low, high, message='Enter a whole number.'):
    n = number(v, low, high)
    if not n.is_integer():
        raise ValueError(message)
    return int(n)


def flag(v):
    return v is True or v in ('on', 'true', '1', 1)


def clean_image(v):
    if v and not re.fullmatch(r'/uploads/[A-Za-z0-9_-]+\.(?:png|jpg|webp)', str(v)):
        raise ValueError('Upload an image first.')
    return v or ''


def normalize_phone(v):
    """Return an E.164 phone number. Ethiopian local formats are accepted."""
    if not isinstance(v, str):
        raise ValueError('Enter your mobile number.')
    raw = re.sub(r'[\s().-]', '', v)
    if re.fullmatch(r'0?[79]\d{8}', raw):
        return '+251' + raw[-9:]
    if re.fullmatch(r'(?:\+|00)251[79]\d{8}', raw):
        return '+251' + raw[-9:]
    if re.fullmatch(r'(?:\+|00)[1-9]\d{7,14}', raw):
        return '+' + raw.lstrip('+').removeprefix('00')
    raise ValueError('Enter a valid mobile number, for example 0911 234 567.')


def contrast_with_white(hex_color):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    return 1.05 / (lum + 0.05)


# ---------------------------------------------------------------- workspace state

def blank(name):
    return {'name': name, 'description': 'Extraordinary nights, beautifully simple.', 'currency': 'ETB',
            'events': [], 'tables': [], 'menu': [], 'orders': [], 'bookings': [],
            'settings': copy.deepcopy(DEFAULT_SETTINGS)}


def upgrade(s):
    """Bring older workspace documents up to the current shape. Idempotent."""
    settings = s.setdefault('settings', {})
    for group, defaults in DEFAULT_SETTINGS.items():
        current = settings.setdefault(group, {})
        for key, value in defaults.items():
            current.setdefault(key, copy.deepcopy(value))
    for key in ['events', 'tables', 'menu', 'orders', 'bookings']:
        s.setdefault(key, [])
    codes = {t.get('code') for t in s['tables']}
    for t in s['tables']:
        if not t.get('code'):
            code = short_code()
            while code in codes:
                code = short_code()
            t['code'] = code
            codes.add(code)
    tips = settings['tips']
    if tips.get('unit') != 'amount':  # older workspaces stored percentage presets
        tips.update(unit='amount', presets=[20, 50, 100])
    tax = settings['tax']
    if tax.get('regime') not in TAX_REGIMES:  # turnover tax was removed
        tax['regime'] = 'none'
    tax.pop('totRate', None)
    for item in s['menu']:
        item.setdefault('events', [])
        if item.get('category') and item['category'] not in settings['menu']['categories']:
            settings['menu']['categories'].append(item['category'])
    return s


def public_settings(s):
    keep = ['theme', 'ticketing', 'ordering', 'tips', 'payments', 'support', 'legal', 'profile', 'menu', 'tax']
    return {k: copy.deepcopy(s['settings'][k]) for k in keep}


def map_link(s):
    """Google Maps link for the organizer: the saved link, or a search for the address and city."""
    p = s['settings']['profile']
    if p.get('mapUrl'):
        return p['mapUrl']
    query = ', '.join(x for x in [p.get('address'), p.get('city'), 'Ethiopia'] if x)
    return 'https://www.google.com/maps/search/?api=1&query=' + quote(query) if (p.get('address') or p.get('city')) else ''


def sold(s, event_id):
    return sum(b.get('qty', 0) for b in s['bookings'] if b.get('event') == event_id and b.get('status') in HOLDING_STATUSES)


def public_state(s):
    out = {k: s[k] for k in ['name', 'description', 'currency']}
    out['settings'] = public_settings(s)
    out['mapLink'] = map_link(s)
    show_remaining = s['settings']['ticketing']['showRemaining']
    out['events'] = []
    for e in s['events']:
        if not e.get('published'):
            continue
        item = {k: e.get(k) for k in ['id', 'name', 'date', 'venue', 'description', 'price', 'image']}
        remaining = max(0, e['capacity'] - sold(s, e['id']))
        item['soldOut'] = remaining == 0
        if show_remaining:
            item['remaining'] = remaining
        out['events'].append(item)
    published = {e['id'] for e in out['events']}
    out['menu'] = [{k: i.get(k) for k in ['id', 'name', 'description', 'price', 'category', 'available', 'image', 'events']}
                   for i in s['menu']]
    out['tables'] = [{k: t[k] for k in ['id', 'name', 'event', 'seats', 'status']} for t in s['tables'] if t['event'] in published]
    return out


def find_table(s, token=None, code=None):
    for t in s['tables']:
        if token and hmac.compare_digest(t['token'], str(token)):
            return t
        if code and hmac.compare_digest(t.get('code', ''), str(code).strip().upper()):
            return t
    return None


# ---------------------------------------------------------------- settings

def configure(s, group, v):
    if group not in DEFAULT_SETTINGS:
        raise ValueError('Unknown settings section.')
    if not isinstance(v, dict):
        raise ValueError('Invalid settings.')
    cfg = s['settings'][group]
    if group == 'theme':
        accent = str(v.get('accent', cfg['accent']))
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', accent):
            raise ValueError('Choose a valid accent color.')
        if contrast_with_white(accent) < 3:
            raise ValueError('That accent is too light for white button text. Choose a deeper color.')
        mode = v.get('mode', cfg['mode'])
        if mode not in ['light', 'dark', 'system']:
            raise ValueError('Choose light, dark or system appearance.')
        admin_mode = v.get('adminMode', cfg.get('adminMode', 'light'))
        if admin_mode not in ['light', 'dark', 'system']:
            raise ValueError('Choose light, dark or system appearance for the dashboard.')
        cfg.update(accent=accent.upper(), mode=mode, adminMode=admin_mode, logo=clean_image(v.get('logo', '')), cover=clean_image(v.get('cover', '')))
    elif group == 'ticketing':
        cfg.update(enabled=flag(v.get('enabled')), showRemaining=flag(v.get('showRemaining')),
                   maxPerOrder=whole(v.get('maxPerOrder', cfg['maxPerOrder']), 1, 20, 'Tickets per order must be between 1 and 20.'))
    elif group == 'ordering':
        cfg.update(enabled=flag(v.get('enabled')), requireScan=flag(v.get('requireScan')),
                   ticketHoldersOnly=flag(v.get('ticketHoldersOnly')), eventMenus=flag(v.get('eventMenus')))
        if cfg['ticketHoldersOnly'] and not cfg['requireScan']:
            raise ValueError('Ticket-holder ordering needs table scanning, so Encore knows which concert the guest is at.')
    elif group == 'tips':
        presets = v.get('presets', cfg['presets'])
        if isinstance(presets, str):
            presets = [p for p in re.split(r'[\s,]+', presets) if p]
        if not isinstance(presets, list) or len(presets) > 5:
            raise ValueError('Offer up to five tip options.')
        presets = sorted({whole(p, 1, 50000, 'Tip options must be whole amounts from 1 to 50,000.') for p in presets})
        cfg.update(enabled=flag(v.get('enabled')), custom=flag(v.get('custom')), presets=presets, unit='amount')
        if cfg['enabled'] and not presets and not cfg['custom']:
            raise ValueError('Add at least one tip option or allow custom tips.')
    elif group == 'payments':
        cfg.update(venue=flag(v.get('venue')))
    elif group == 'notifications':
        cfg.update(smsBookings=flag(v.get('smsBookings')), smsOrderReady=flag(v.get('smsOrderReady')),
                   staffNewOrders=flag(v.get('staffNewOrders')))
    elif group == 'support':
        faq = v.get('faq', [])
        if not isinstance(faq, list) or len(faq) > 20:
            raise ValueError('Add up to 20 help questions.')
        clean_faq = []
        for entry in faq:
            if not isinstance(entry, dict):
                raise ValueError('Invalid help question.')
            q, a = text(entry.get('q'), 150, False), text(entry.get('a'), 1000, False)
            if q or a:
                if not (q and a):
                    raise ValueError('Each help question needs both a question and an answer.')
                clean_faq.append({'q': q, 'a': a})
        cfg.update(email=email(v.get('email'), False), phone=text(v.get('phone'), 30, False),
                   hours=text(v.get('hours'), 120, False), faq=clean_faq)
    elif group == 'profile':
        photos = v.get('photos', [])
        if not isinstance(photos, list) or len(photos) > 500:
            raise ValueError('That is a lot of photos — keep it under 500.')
        map_url = text(v.get('mapUrl'), 500, False)
        if map_url and not re.match(r'https://', map_url):
            raise ValueError('The map link must start with https://')
        if map_url and not re.match(r'https://(?:www\.)?(?:google\.[a-z.]+/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl/maps)', map_url):
            raise ValueError('Use a Google Maps link (google.com/maps or maps.app.goo.gl).')
        cfg.update(city=text(v.get('city'), 80, False), address=text(v.get('address'), 200, False), mapUrl=map_url,
                   photos=[clean_image(p) for p in photos if p])
    elif group == 'menu':
        raw = v.get('categories', [])
        if not isinstance(raw, list) or not 1 <= len(raw) <= 30:
            raise ValueError('Keep between 1 and 30 menu categories.')
        categories = []
        for name in raw:
            name = text(name, 60)
            if name.lower() in [c.lower() for c in categories]:
                raise ValueError(f'"{name}" is listed twice.')
            categories.append(name)
        renames = v.get('renames') or {}
        if not isinstance(renames, dict):
            raise ValueError('Invalid category changes.')
        for item in s['menu']:
            item['category'] = renames.get(item.get('category'), item.get('category'))
        in_use = sorted({i['category'] for i in s['menu'] if i['category'] not in categories})
        if in_use:
            raise ValueError(f'Move menu items out of {", ".join(in_use)} before removing it.')
        cfg['categories'] = categories
    elif group == 'tax':
        regime = v.get('regime', cfg['regime'])
        if regime not in TAX_REGIMES:
            raise ValueError('Choose VAT or no tax.')
        tin = text(v.get('tin'), 20, False)
        if tin and not re.fullmatch(r'\d{10}', tin):
            raise ValueError('An Ethiopian TIN has 10 digits.')
        cfg.update(regime=regime, vatRate=number(v.get('vatRate', cfg['vatRate']), 0, 50),
                   pricesIncludeTax=flag(v.get('pricesIncludeTax')), tin=tin, vatNumber=text(v.get('vatNumber'), 30, False),
                   tickets=flag(v.get('tickets')), menu=flag(v.get('menu')))
        if regime != 'none' and not tin:
            raise ValueError('Enter your 10-digit TIN to show tax on receipts.')
    elif group == 'legal':
        cfg.update(terms=text(v.get('terms'), 20000, False), privacy=text(v.get('privacy'), 20000, False))
    return s


# ---------------------------------------------------------------- staff actions

def mutate(s, op, v, notices):
    """Apply a staff action. Guest-facing consequences are appended to `notices`
    as dicts {guest, kind, title, body}."""
    if not isinstance(v, dict):
        raise ValueError('Invalid request.')
    if op == 'settings':
        s['name'] = text(v.get('name'), 80)
        s['description'] = text(v.get('description'), 500)
        if v.get('currency') not in CURRENCIES:
            raise ValueError('Select a currency.')
        s['currency'] = v['currency']
    elif op == 'config':
        configure(s, v.get('group'), v.get('values'))
    elif op in ['event', 'menu', 'table']:
        collection = {'event': 'events', 'menu': 'menu', 'table': 'tables'}[op]
        old = next((a for a in s[collection] if a['id'] == v.get('id')), None)
        if v.get('id') and not old:
            raise ValueError('This item no longer exists in your workspace.')
        item = dict(old or {'id': uid()})
        item['name'] = text(v.get('name'), 120)
        if op == 'event':
            item.update(date=text(v.get('date'), 30), venue=text(v.get('venue'), 150), description=text(v.get('description'), 1000),
                        price=round(number(v.get('price')) * 100), capacity=whole(v.get('capacity'), 1, 100000, 'Capacity must be a whole number.'),
                        published=flag(v.get('published')), image=clean_image(v.get('image')))
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', item['date']):
                raise ValueError('Choose the event date and time.')
            if old and item['capacity'] < sold(s, item['id']):
                raise ValueError('Capacity cannot be lower than the tickets already reserved.')
        elif op == 'menu':
            events = v.get('events') or []
            if not isinstance(events, list) or any(not any(e['id'] == x for e in s['events']) for x in events):
                raise ValueError('Choose concerts from your workspace.')
            item.update(description=text(v.get('description'), 500), price=round(number(v.get('price')) * 100),
                        category=_category(s, v.get('category')), available=flag(v.get('available')),
                        image=clean_image(v.get('image')), events=sorted(set(events)))
        else:
            if old and old['event'] != v.get('event'):
                raise ValueError('A table QR code stays linked to its original concert. Create a new table for another concert.')
            event = next((e for e in s['events'] if e['id'] == v.get('event')), None)
            if not event:
                raise ValueError('Choose the concert for this table.')
            status = v.get('status', 'Available')
            if status not in ['Available', 'Reserved', 'Blocked']:
                raise ValueError('Invalid table status.')
            codes = {t.get('code') for t in s['tables'] if t['id'] != item['id']}
            code = item.get('code') or short_code()
            while code in codes:
                code = short_code()
            item.update(event=event['id'], seats=whole(v.get('seats'), 1, 30, 'Seats must be a whole number.'), status=status,
                        token=item.get('token') or uid(), code=code)
        s[collection] = [item if a['id'] == item['id'] else a for a in s[collection]] if old else s[collection] + [item]
    elif op == 'delete':
        kind = v.get('kind')
        collection = {'event': 'events', 'menu': 'menu', 'table': 'tables'}.get(kind)
        if not collection or not any(a['id'] == v.get('id') for a in s[collection]):
            raise ValueError('This item no longer exists in your workspace.')
        if kind == 'event' and (any(b.get('event') == v['id'] for b in s['bookings']) or any(t['event'] == v['id'] for t in s['tables'])):
            raise ValueError('This concert has bookings or tables. Unpublish it instead of deleting it.')
        s[collection] = [a for a in s[collection] if a['id'] != v['id']]
        if kind == 'event':
            for item in s['menu']:
                item['events'] = [e for e in item.get('events', []) if e != v['id']]
    elif op == 'order_status':
        o = next((o for o in s['orders'] if o['id'] == v.get('id')), None)
        if not o or ORDER_FLOW.get(o['status']) != v.get('status'):
            raise ValueError('This order cannot move to that status.')
        o['status'] = v['status']
        where = o.get('tableName') or 'the service counter'
        body = {'Preparing': 'Your order is being prepared.', 'Ready': f'Your order is ready and on its way to {where}.',
                'Delivered': 'Your order has been delivered. Enjoy the show!'}[o['status']]
        notices.append({'record': o, 'kind': 'order_' + o['status'].lower(), 'title': f'Order {o["ref"]}: {o["status"]}', 'body': body})
    elif op == 'settle':
        rec = next((r for r in s['orders'] + s['bookings'] if r['id'] == v.get('id')), None)
        if not rec:
            raise ValueError('That record no longer exists in your workspace.')
        if rec.get('paid'):
            raise ValueError('This has already been marked as paid.')
        if rec.get('status') == 'Cancelled':
            raise ValueError('A cancelled record cannot be paid.')
        method = v.get('method', 'Cash')
        if method not in SETTLEMENT_METHODS:
            raise ValueError('Select how the guest paid.')
        rec.update(paid=True, settledBy=method, settledAt=int(time.time()))
        notices.append({'record': rec, 'kind': 'paid', 'title': f'Payment received · {rec["ref"]}', 'body': f'Thank you. Your payment ({method}) was recorded.'})
    elif op == 'cancel':
        rec = next((r for r in s['orders'] + s['bookings'] if r['id'] == v.get('id')), None)
        if not rec:
            raise ValueError('That record no longer exists in your workspace.')
        if rec.get('status') in ['Checked in', 'Delivered', 'Cancelled'] or rec.get('paid'):
            raise ValueError('This record can no longer be cancelled.')
        rec['status'] = 'Cancelled'
        notices.append({'record': rec, 'kind': 'cancelled', 'title': f'{rec["ref"]} was cancelled', 'body': 'The organizer cancelled this reservation. Contact support if you have questions.'})
    elif op == 'checkin':
        b = next((b for b in s['bookings'] if b['id'] == v.get('id')), None)
        _check_in(b, None, v.get('_by'))
        notices.append({'record': b, 'kind': 'checkin', 'title': 'Welcome in!', 'body': f'You are checked in to {b["eventName"]}. Have a great night.'})
    elif op == 'checkin_ticket':
        value = str(v.get('code', '')).strip()
        parts = value.split(':')
        b = ticket = None
        if len(parts) == 3:  # scanned QR: REF:serial:token
            b = next((b for b in s['bookings'] if b.get('ref') == parts[0]), None)
            ticket = next((t for t in (b or {}).get('tickets', []) if hmac.compare_digest(t['token'], parts[2])), None)
        else:  # typed reference number, e.g. EN-ABC123 or ABC123: admits the next ticket not yet used
            ref = value.upper().replace(' ', '')
            ref = ref if ref.startswith('EN-') else 'EN-' + ref
            b = next((b for b in s['bookings'] if b.get('ref') == ref), None)
            if b:
                ticket = next((t for t in b['tickets'] if not t['used']), None)
                if not ticket:
                    raise ValueError(f'All {b["qty"]} ticket{"s" if b["qty"] > 1 else ""} on {ref} have already been checked in.')
        if not ticket:
            raise ValueError('No ticket found for that QR code or reference number.')
        _check_in(b, ticket, v.get('_by'))
        v['result'] = {'name': b['name'], 'event': b['eventName'], 'serial': ticket['serial'], 'qty': b['qty'], 'ref': b['ref'],
                       'remaining': sum(1 for t in b['tickets'] if not t['used'])}
    else:
        raise ValueError('Unknown action.')
    return s


def _category(s, value):
    name = text(value, 60)
    match = next((c for c in s['settings']['menu']['categories'] if c.lower() == name.lower()), None)
    if not match:
        raise ValueError('Choose a category from Settings → Menu categories.')
    return match


def tax_for(s, kind, taxable_cents):
    """Ethiopian VAT/TOT on a taxable amount in cents. Tips are never taxed here."""
    cfg = s['settings']['tax']
    applies = cfg['regime'] != 'none' and cfg['tickets' if kind == 'booking' else 'menu']
    if not applies or taxable_cents <= 0:
        return None
    rate = cfg['vatRate']
    if not rate:
        return None
    r = Fraction(str(rate))
    exact = Fraction(taxable_cents) * r / (100 + r) if cfg['pricesIncludeTax'] else Fraction(taxable_cents) * r / 100
    amount = int(exact + Fraction(1, 2))  # round half up to the nearest cent, exactly
    label = f'VAT {rate:g}%'
    return {'label': label, 'rate': rate, 'amount': amount, 'included': cfg['pricesIncludeTax'], 'regime': cfg['regime']}


def _check_in(b, ticket, by=None):
    if not b:
        raise ValueError('Ticket is invalid.')
    if b['status'] == 'Cancelled':
        raise ValueError('This booking was cancelled.')
    if not b.get('paid'):
        raise ValueError('Take payment for this booking before checking the guest in.')
    tickets = [ticket] if ticket else [t for t in b['tickets'] if not t['used']]
    if not tickets or all(t['used'] for t in tickets):
        raise ValueError('This ticket has already been checked in.')
    for t in tickets:
        t['used'] = True
        t['usedAt'] = int(time.time())
        t['usedBy'] = by or ''
    if all(t['used'] for t in b['tickets']):
        b['status'] = 'Checked in'


# ---------------------------------------------------------------- pricing and guest records

def guest_event_ids(s, guest_id):
    return {b['event'] for b in s['bookings'] if guest_id and b.get('guest') == guest_id and b.get('status') in HOLDING_STATUSES}


def quote_order(s, v, guest_id=None):
    cfg = s['settings']
    lines, tip, table = [], 0, None
    if v.get('kind') == 'booking':
        if not cfg['ticketing']['enabled']:
            raise ValueError('Ticket reservations are closed for this organizer.')
        e = next((e for e in s['events'] if e['id'] == v.get('event') and e.get('published')), None)
        if not e:
            raise ValueError('This event is not available for booking.')
        limit = cfg['ticketing']['maxPerOrder']
        qty = whole(v.get('qty'), 1, 1000, 'Ticket quantity must be a whole number.')
        if qty > limit:
            raise ValueError(f'You can reserve up to {limit} tickets per order.')
        if sold(s, e['id']) + qty > e['capacity']:
            raise ValueError('There are not enough tickets available.')
        lines = [{'name': e['name'], 'qty': qty, 'total': e['price'] * qty}]
    elif v.get('kind') == 'menu':
        if not cfg['ordering']['enabled']:
            raise ValueError('Food and drink ordering is closed right now.')
        if v.get('table'):
            table = find_table(s, token=v['table'])
            if not table or table['status'] == 'Blocked':
                raise ValueError('This table is not available for ordering.')
            if not any(e['id'] == table['event'] and e.get('published') for e in s['events']):
                raise ValueError('Table ordering is not open for this concert.')
        elif cfg['ordering']['requireScan']:
            raise ValueError("Scan the QR code on your table to order.")
        if table and cfg['ordering']['ticketHoldersOnly'] and table['event'] not in guest_event_ids(s, guest_id):
            raise ValueError('Ordering at this table is for ticket holders of this concert.')
        cart = v.get('items')
        if not isinstance(cart, dict) or not cart or len(cart) > 100:
            raise ValueError('Your bag is empty or invalid.')
        for item_id, count in cart.items():
            qty = whole(count, 0, 50, 'Item quantities must be whole numbers.')
            if qty == 0:
                continue
            item = next((i for i in s['menu'] if i['id'] == item_id and i.get('available')), None)
            if not item:
                raise ValueError('An item in your bag is no longer available.')
            if table and cfg['ordering']['eventMenus'] and item.get('events') and table['event'] not in item['events']:
                raise ValueError(f'{item["name"]} is not served at this concert.')
            lines.append({'name': item['name'], 'qty': qty, 'total': item['price'] * qty})
        if not lines:
            raise ValueError('Your bag is empty.')
        tip = money_cents(v.get('tipAmount', 0), MAX_TIP_CENTS, 'Enter a tip between 0 and 50,000.')
        tips = cfg['tips']
        if tip:
            if not tips['enabled']:
                raise ValueError('Tips are not accepted by this organizer.')
            if not tips['custom'] and tip not in [p * 100 for p in tips['presets']]:
                raise ValueError('Choose one of the offered tip amounts.')
    else:
        raise ValueError('Choose tickets or a menu order.')
    subtotal = sum(i['total'] for i in lines)
    tax = tax_for(s, v.get('kind'), subtotal)
    extra = tax['amount'] if tax and not tax['included'] else 0
    cfg = s['settings']['tax']
    return {'merchant': s['name'], 'currency': s['currency'], 'lines': lines, 'subtotal': subtotal, 'tip': tip, 'tax': tax,
            'total': subtotal + extra + tip, 'fee': None, 'tableName': table['name'] if table else None,
            'tableEvent': table['event'] if table else None,
            'tin': cfg['tin'] if tax else '', 'vatNumber': cfg['vatNumber'] if tax else ''}


def reference():
    return 'EN-' + short_code()


def guest_record(s, v, guest, demo_payment=False):
    """Create a booking or table order for a signed-in guest.

    Normally settled in person at the venue and created unpaid. `demo_payment` is used only by the
    server's explicit demo mode: the record is marked paid by a clearly labelled simulated payment.
    """
    if v.get('kind') == 'booking' and not demo_payment:
        raise ValueError('Tickets are paid online only.')
    if not demo_payment and not s['settings']['payments']['venue']:
        raise ValueError('Pay-at-table orders are not available. Please pay online.')
    q = quote_order(s, v, guest['id'])
    rec = {'id': uid(), 'ref': reference(), 'token': uid(), 'guest': guest['id'], 'name': guest['name'], 'phone': guest['phone'],
           'email': email(v.get('email'), False), 'currency': s['currency'], 'total': q['total'], 'subtotal': q['subtotal'],
           'lines': q['lines'], 'tax': q['tax'], 'tin': q['tin'], 'vatNumber': q['vatNumber'],
           'paid': False, 'settlement': 'venue', 'created': int(time.time())}
    if v.get('kind') == 'booking':
        e = next(e for e in s['events'] if e['id'] == v['event'])
        qty = q['lines'][0]['qty']
        rec.update(event=e['id'], eventName=e['name'], venue=e.get('venue', ''), date=e.get('date', ''), qty=qty, status='Reserved',
                   tickets=[{'serial': i + 1, 'token': uid(), 'used': False} for i in range(qty)])
        s['bookings'].append(rec)
    else:
        rec.update(tip=q['tip'], tableName=q['tableName'], event=q['tableEvent'], status='Placed',
                   items=', '.join(f'{l["qty"]} × {l["name"]}' for l in q['lines']))
        if v.get('table'):
            rec['table'] = find_table(s, token=v['table'])['id']
        s['orders'].append(rec)
    if demo_payment:
        rec.update(paid=True, settlement='demo', settledBy='Demo payment (simulated)', settledAt=int(time.time()))
    return rec


def receipt(s, rec):
    keep = ['ref', 'token', 'name', 'phone', 'email', 'currency', 'total', 'subtotal', 'lines', 'paid', 'settlement', 'created',
            'status', 'tip', 'tableName', 'items', 'event', 'eventName', 'venue', 'date', 'qty', 'tickets', 'settledBy', 'settledAt',
            'tax', 'tin', 'vatNumber']
    out = {k: copy.deepcopy(rec[k]) for k in keep if k in rec}
    for t in out.get('tickets', []):
        t.pop('usedBy', None)  # staff names stay internal
    out['merchant'] = s['name']
    out['kind'] = 'booking' if 'qty' in rec else 'order'
    return out
