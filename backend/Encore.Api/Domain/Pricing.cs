using System.Globalization;
using System.Numerics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Encore.Api.Persistence;

namespace Encore.Api.Domain;

/// <summary>
/// Server-side prices, VAT, service charge and tips, ported from the original Python rules (sold, find_table, find_waiter,
/// guest_event_ids, tax_for, service_for, quote_order). Every amount is integer cents; nothing the browser
/// sends as a price or total is used. The quote keeps the JSON shape the screens already use.
/// </summary>
public static partial class Pricing
{
    private static readonly string[] HoldingStatuses = ["Reserved", "Checked in"];

    public static long Sold(Workspace s, string? eventId) =>
        s.Bookings.Where(b => Str(b["event"]) == eventId && HoldingStatuses.Contains(Str(b["status"])))
            .Sum(b => b["qty"] is null ? 0L : Values.Long(b["qty"]));

    public static JsonObject? FindTable(Workspace s, string? token = null, string? code = null)
    {
        foreach (var t in s.Tables)
        {
            if (!string.IsNullOrEmpty(token) && Values.SameSecret(Str(t["token"]) ?? "", token)) return t;
            if (!string.IsNullOrEmpty(code) && Values.SameSecret(Str(t["code"]) ?? "", code.Trim().ToUpperInvariant())) return t;
        }
        return null;
    }

    public static HashSet<string> GuestEventIds(Workspace s, string? guestId) =>
        string.IsNullOrEmpty(guestId) ? [] : s.Bookings
            .Where(b => Str(b["guest"]) == guestId && HoldingStatuses.Contains(Str(b["status"])))
            .Select(b => Str(b["event"]) ?? "").ToHashSet();

    public static JsonObject? FindWaiter(Workspace s, JsonNode? number)
    {
        var raw = number is null || !Values.Truthy(number) ? "" : Values.Show(number);
        var value = NotDigits().Replace(raw, "");
        if (value.Length == 0) return null;
        return s.Waiters.FirstOrDefault(w => Values.Truthy(w["active"]) && Values.SameSecret(Str(w["number"]) ?? "", value))
            ?? throw new DomainException("We could not find a waiter with that number. Check the number on their badge.");
    }

    /// <summary>VAT on an amount in cents, rounded half up to the cent exactly. Tips are never taxed.</summary>
    public static JsonObject? TaxFor(Workspace s, string? kind, long taxableCents)
    {
        var cfg = Group(s, "tax");
        var applies = Str(cfg["regime"]) != "none" && Values.Truthy(cfg[kind == "booking" ? "tickets" : "menu"]);
        if (!applies || taxableCents <= 0) return null;
        var rateNode = cfg["vatRate"];
        if (!Values.Truthy(rateNode)) return null;
        var (num, den) = Rational(Values.Decimal(rateNode));
        var included = Values.Truthy(cfg["pricesIncludeTax"]);
        // included: taxable × r / (100 + r); on top: taxable × r / 100, with r = num/den.
        var amount = included
            ? RoundHalfUp(taxableCents * num, 100 * den + num)
            : RoundHalfUp(taxableCents * num, 100 * den);
        return new JsonObject
        {
            ["label"] = $"VAT {General(Values.Decimal(rateNode))}%",
            ["rate"] = rateNode!.DeepClone(),
            ["amount"] = amount,
            ["included"] = cfg["pricesIncludeTax"]?.DeepClone(),
            ["regime"] = cfg["regime"]?.DeepClone(),
        };
    }

    public static JsonObject? ServiceFor(Workspace s, long subtotal)
    {
        var cfg = Group(s, "service");
        if (!Values.Truthy(cfg["enabled"]) || !Values.Truthy(cfg["rate"]) || subtotal <= 0) return null;
        var (num, den) = Rational(Values.Decimal(cfg["rate"]));
        return new JsonObject
        {
            ["label"] = $"Service charge {General(Values.Decimal(cfg["rate"]))}%",
            ["rate"] = cfg["rate"]!.DeepClone(),
            ["amount"] = RoundHalfUp(subtotal * num, 100 * den),
        };
    }

    public static JsonObject QuoteOrder(Workspace s, JsonObject v, string? guestId = null, bool staff = false)
    {
        var kind = Str(v["kind"]);
        var lines = new List<JsonObject>();
        long tip = 0;
        JsonObject? table = null, waiter = null;

        if (kind == "booking")
        {
            if (!Values.Truthy(Group(s, "ticketing")["enabled"]))
                throw new DomainException("Ticket reservations are closed for this organizer.");
            var e = s.Events.FirstOrDefault(e => Str(e["id"]) == Str(v["event"]) && Values.Truthy(e["published"]))
                ?? throw new DomainException("This event is not available for booking.");
            var limit = Group(s, "ticketing")["maxPerOrder"];
            var qty = Values.Whole(v["qty"], 1, 1000, "Ticket quantity must be a whole number.");
            if (qty > Values.Decimal(limit)) throw new DomainException($"You can reserve up to {Values.Show(limit)} tickets per order.");
            if (Sold(s, Str(e["id"])) + qty > Values.Decimal(e["capacity"]))
                throw new DomainException("There are not enough tickets available.");
            lines.Add(new JsonObject { ["name"] = e["name"]?.DeepClone(), ["qty"] = qty, ["total"] = Cents(e["price"]) * qty });
        }
        else if (kind == "menu")
        {
            var ordering = Group(s, "ordering");
            if (!Values.Truthy(ordering["enabled"])) throw new DomainException("Food and drink ordering is closed right now.");
            if (staff && Values.Truthy(v["tableId"]))
            {
                table = s.Tables.FirstOrDefault(t => Str(t["id"]) == Str(v["tableId"]))
                    ?? throw new DomainException("Choose a table from your workspace.");
            }
            else if (Values.Truthy(v["table"]))
            {
                table = FindTable(s, token: Values.Show(v["table"]));
                if (table is null || Str(table["status"]) == "Blocked") throw new DomainException("This table is not available for ordering.");
                var tableEvent = Str(table["event"]);
                if (!s.Events.Any(e => Str(e["id"]) == tableEvent && Values.Truthy(e["published"])))
                    throw new DomainException("Table ordering is not open for this concert.");
            }
            else if (Values.Truthy(ordering["requireScan"]) && !staff)
            {
                throw new DomainException("Scan the QR code on your table to order.");
            }
            if (table is not null && !staff && Values.Truthy(ordering["ticketHoldersOnly"])
                && !GuestEventIds(s, guestId).Contains(Str(table["event"]) ?? ""))
                throw new DomainException("Ordering at this table is for ticket holders of this concert.");

            if (v["items"] is not JsonObject cart || cart.Count == 0 || cart.Count > 100)
                throw new DomainException("Your bag is empty or invalid.");
            foreach (var (itemId, count) in cart)
            {
                var qty = Values.Whole(count, 0, 50, "Item quantities must be whole numbers.");
                if (qty == 0) continue;
                var item = s.Menu.FirstOrDefault(i => Str(i["id"]) == itemId && Values.Truthy(i["available"]))
                    ?? throw new DomainException("An item in your bag is no longer available.");
                var name = Values.Show(item["name"]);
                if (table is not null && Values.Truthy(ordering["eventMenus"]) && item["events"] is JsonArray events && events.Count > 0
                    && !events.Any(x => Str(x) == Str(table["event"])))
                    throw new DomainException($"{name} is not served at this concert.");
                if (Values.Truthy(item["trackStock"]) && Values.Decimal(item["stock"]) < qty)
                    throw new DomainException(Values.Decimal(item["stock"]) > 0 ? $"Only {Values.Show(item["stock"])} {name} left." : $"{name} is sold out.");
                var price = Cents(item["price"]);
                lines.Add(new JsonObject
                {
                    ["id"] = item["id"]?.DeepClone(), ["name"] = item["name"]?.DeepClone(), ["qty"] = qty,
                    ["price"] = item["price"]?.DeepClone(), ["total"] = price * qty,
                });
            }
            if (lines.Count == 0) throw new DomainException("Your bag is empty.");
            waiter = FindWaiter(s, v["waiter"]);
            tip = Values.MoneyCents(v["tipAmount"] ?? 0, Values.MaxTipCents, "Enter a tip between 0 and 50,000.");
            var tips = Group(s, "tips");
            if (tip != 0)
            {
                if (!Values.Truthy(tips["enabled"])) throw new DomainException("Tips are not accepted by this organizer.");
                if (!Values.Truthy(tips["custom"]) && !(tips["presets"] as JsonArray ?? []).Any(p => Values.Decimal(p) * 100 == tip))
                    throw new DomainException("Choose one of the offered tip amounts.");
            }
        }
        else
        {
            throw new DomainException("Choose tickets or a menu order.");
        }

        var subtotal = lines.Sum(l => Values.Long(l["total"]));
        var service = kind == "menu" ? ServiceFor(s, subtotal) : null;
        var serviceAmount = service is null ? 0 : Values.Long(service["amount"]);
        var tax = TaxFor(s, kind, subtotal + serviceAmount); // VAT applies to the service charge too
        var extra = tax is not null && !Values.Truthy(tax["included"]) ? Values.Long(tax["amount"]) : 0;
        var taxCfg = Group(s, "tax");
        var w = kind == "menu" ? waiter : null;
        return new JsonObject
        {
            ["merchant"] = s.Name,
            ["currency"] = s.Currency,
            ["lines"] = new JsonArray([.. lines]),
            ["subtotal"] = subtotal,
            ["tip"] = tip,
            ["tax"] = tax,
            ["service"] = service,
            ["waiter"] = w is null ? null : new JsonObject
            {
                ["id"] = w["id"]?.DeepClone(), ["name"] = Values.Show(w["name"]).Split(' ')[0], ["number"] = w["number"]?.DeepClone(),
            },
            ["total"] = subtotal + serviceAmount + extra + tip,
            ["fee"] = null,
            ["tableName"] = table?["name"]?.DeepClone(),
            ["tableEvent"] = table?["event"]?.DeepClone(),
            ["tin"] = tax is not null ? taxCfg["tin"]?.DeepClone() : "",
            ["vatNumber"] = tax is not null ? taxCfg["vatNumber"]?.DeepClone() : "",
        };
    }

    private static JsonObject Group(Workspace s, string name) =>
        s.Settings[name] as JsonObject ?? throw new InvalidDataException($"The workspace has no {name} settings; run upgrade first.");

    private static string? Str(JsonNode? v) => v is JsonValue x && x.TryGetValue(out string? s) ? s : null;

    // Stored prices are integer cents; a fractional value would be a corrupted document, so refuse it loudly.
    private static long Cents(JsonNode? v)
    {
        var d = Values.Decimal(v);
        if (d != decimal.Truncate(d)) throw new InvalidDataException("A stored price is not whole cents.");
        return (long)d;
    }

    private static (BigInteger Num, BigInteger Den) Rational(decimal d)
    {
        var bits = decimal.GetBits(d);
        var scale = (bits[3] >> 16) & 0xFF;
        var mantissa = new BigInteger((uint)bits[0]) | (new BigInteger((uint)bits[1]) << 32) | (new BigInteger((uint)bits[2]) << 64);
        if (d < 0) mantissa = -mantissa;
        return (mantissa, BigInteger.Pow(10, scale));
    }

    private static long RoundHalfUp(BigInteger num, BigInteger den) => (long)BigInteger.Divide(2 * num + den, 2 * den);

    /// <summary>Python's "{:g}": 15.0 prints as 15, 12.5 as 12.5.</summary>
    private static string General(decimal d) => Values.PyG((double)d);

    [GeneratedRegex(@"\D")] private static partial Regex NotDigits();
}
