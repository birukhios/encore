using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Encore.Api.Persistence;
using static Encore.Api.Domain.WorkspaceRules;

namespace Encore.Api.Domain;

/// <summary>Something a guest should hear about after a staff action (in-app notification, maybe SMS).</summary>
public sealed record Notice(JsonObject Record, string Kind, string Title, string Body);

/// <summary>Staff actions on a workspace, and the records guests create. Ported from domain.py's mutate and friends.</summary>
public static partial class Actions
{
    public static readonly string[] SettlementMethods = ["Cash", "Card at venue"]; // bank transfers are not accepted
    public static readonly string[] StaffPaymentMethods = ["Cash", "Card at venue"];
    private static readonly Dictionary<string, string> OrderFlow = new() { ["Placed"] = "Preparing", ["Preparing"] = "Ready", ["Ready"] = "Delivered" };
    private const int StockLogLimit = 500;

    /// <summary>Apply a staff action. Anything a guest should be told about is added to <paramref name="notices"/>.</summary>
    public static Workspace Mutate(Workspace s, string? op, JsonNode? data, List<Notice> notices)
    {
        if (data is not JsonObject v) throw new DomainException("Invalid request.");
        var by = Str(v["_by"]);
        switch (op)
        {
            case "settings":
            {
                var name = Values.Text(v["name"], 80);
                var description = Values.Text(v["description"], 500);
                var currency = Str(v["currency"]);
                if (currency is null || !Currencies.Contains(currency)) throw new DomainException("Select a currency.");
                s.Name = name;
                s.Description = description;
                s.Currency = currency;
                break;
            }
            case "config":
                SettingsRules.Configure(s, v["group"], v["values"]);
                break;
            case "event" or "menu" or "table":
                SaveCatalogItem(s, op, v, by);
                break;
            case "delete":
                Delete(s, v);
                break;
            case "order_status":
            {
                var o = s.Orders.FirstOrDefault(o => Str(o["id"]) == Str(v["id"]));
                if (o is null || !OrderFlow.TryGetValue(Str(o["status"]) ?? "", out var next) || next != Str(v["status"]))
                    throw new DomainException("This order cannot move to that status.");
                o["status"] = next;
                var where = Values.Truthy(o["tableName"]) ? Values.Show(o["tableName"]) : "the service counter";
                var body = next switch
                {
                    "Preparing" => "Your order is being prepared.",
                    "Ready" => $"Your order is ready and on its way to {where}.",
                    _ => "Your order has been delivered. Enjoy the show!",
                };
                notices.Add(new Notice(o, "order_" + next.ToLowerInvariant(), $"Order {Values.Show(o["ref"])}: {next}", body));
                break;
            }
            case "settle":
            {
                var rec = s.Orders.Concat(s.Bookings).FirstOrDefault(r => Str(r["id"]) == Str(v["id"]))
                    ?? throw new DomainException("That record no longer exists in your workspace.");
                if (Values.Truthy(rec["paid"])) throw new DomainException("This has already been marked as paid.");
                if (Str(rec["status"]) == "Cancelled") throw new DomainException("A cancelled record cannot be paid.");
                var method = v.ContainsKey("method") ? Str(v["method"]) : "Cash";
                if (method is null || !SettlementMethods.Contains(method)) throw new DomainException("Select how the guest paid.");
                rec["paid"] = true;
                rec["settledBy"] = method;
                rec["settledAt"] = Ids.Now();
                notices.Add(new Notice(rec, "paid", $"Payment received · {Values.Show(rec["ref"])}", $"Thank you. Your payment ({method}) was recorded."));
                break;
            }
            case "cancel":
            {
                var rec = s.Orders.Concat(s.Bookings).FirstOrDefault(r => Str(r["id"]) == Str(v["id"]))
                    ?? throw new DomainException("That record no longer exists in your workspace.");
                if (Str(rec["status"]) is "Checked in" or "Delivered" or "Cancelled" || Values.Truthy(rec["paid"]))
                    throw new DomainException("This record can no longer be cancelled.");
                rec["status"] = "Cancelled";
                if (rec.ContainsKey("lines") && !rec.ContainsKey("qty")) Restock(s, rec, $"Cancelled {Values.Show(rec["ref"])}", by);
                notices.Add(new Notice(rec, "cancelled", $"{Values.Show(rec["ref"])} was cancelled",
                    "The organizer cancelled this reservation. Contact support if you have questions."));
                break;
            }
            case "checkin":
            {
                var b = s.Bookings.FirstOrDefault(b => Str(b["id"]) == Str(v["id"]));
                CheckIn(b, null, by);
                notices.Add(new Notice(b!, "checkin", "Welcome in!", $"You are checked in to {Values.Show(b!["eventName"])}. Have a great night."));
                break;
            }
            case "checkin_ticket":
                CheckInTicket(s, v, by);
                break;
            case "waiter":
                SaveWaiter(s, v);
                break;
            case "stock":
                AdjustMenuStock(s, v, by);
                break;
            case "inventory":
                SaveStoreItem(s, v, by);
                break;
            case "inventory_adjust":
                AdjustStoreItem(s, v, by);
                break;
            case "staff_order":
                v["result"] = StaffOrder(s, v);
                break;
            default:
                throw new DomainException("Unknown action.");
        }
        return s;
    }

    private static void SaveCatalogItem(Workspace s, string op, JsonObject v, string? by)
    {
        var collection = op switch { "event" => s.Events, "menu" => s.Menu, _ => s.Tables };
        var old = collection.FirstOrDefault(a => Str(a["id"]) == Str(v["id"]));
        if (Values.Truthy(v["id"]) && old is null) throw new DomainException("This item no longer exists in your workspace.");
        var item = old?.DeepClone().AsObject() ?? new JsonObject { ["id"] = Ids.Uid() };
        item["name"] = Values.Text(v["name"], 120);
        var id = Str(item["id"]);

        if (op == "event")
        {
            var date = Values.Text(v["date"], 30);
            var venue = Values.Text(v["venue"], 150);
            var description = Values.Text(v["description"], 1000);
            var price = PriceCents(v["price"]);
            var capacity = Values.Whole(v["capacity"], 1, 100000, "Capacity must be a whole number.");
            var published = Values.Flag(v["published"]);
            var image = SettingsRules.CleanImage(v["image"]);
            item["date"] = date;
            item["venue"] = venue;
            item["description"] = description;
            item["price"] = price;
            item["capacity"] = capacity;
            item["published"] = published;
            item["image"] = image;
            if (!EventDate().IsMatch(date)) throw new DomainException("Choose the event date and time.");
            if (old is not null && capacity < Pricing.Sold(s, id)) throw new DomainException("Capacity cannot be lower than the tickets already reserved.");
        }
        else if (op == "menu")
        {
            var eventsNode = Values.Truthy(v["events"]) ? v["events"] : new JsonArray();
            if (eventsNode is not JsonArray events || events.Any(x => !s.Events.Any(e => Str(e["id"]) is { } eid && eid == Str(x))))
                throw new DomainException("Choose concerts from your workspace.");
            item["description"] = Values.Text(v["description"], 500);
            item["price"] = PriceCents(v["price"]);
            item["category"] = Category(s, v["category"]);
            item["available"] = Values.Flag(v["available"]);
            item["image"] = SettingsRules.CleanImage(v["image"]);
            item["events"] = new JsonArray([.. events.Select(Str).Distinct().Order(StringComparer.Ordinal).Select(x => (JsonNode?)x)]);
            var wasTracked = old is not null && Values.Truthy(old["trackStock"]);
            item["trackStock"] = Values.Flag(v["trackStock"]);
            item["lowStock"] = Values.Whole(v.ContainsKey("lowStock") ? v["lowStock"] : item["lowStock"] ?? 5, 0, 100000, "Low-stock alert must be a whole number.");
            if (!item.ContainsKey("stock")) item["stock"] = 0;
            if (Values.Truthy(item["trackStock"]) && !wasTracked) // starting count; later changes go through stock adjustments
            {
                var count = Values.Whole(v.ContainsKey("stock") ? v["stock"] : 0, 0, 1_000_000, "Stock must be a whole number.");
                StockLog(s, item, count - Values.Long(item["stock"]), "Opening count", by);
                item["stock"] = count;
            }
        }
        else
        {
            if (old is not null && Str(old["event"]) != Str(v["event"]))
                throw new DomainException("A table QR code stays linked to its original concert. Create a new table for another concert.");
            var ev = s.Events.FirstOrDefault(e => Str(e["id"]) is { } eid && eid == Str(v["event"]))
                ?? throw new DomainException("Choose the concert for this table.");
            var status = v.ContainsKey("status") ? Str(v["status"]) : "Available";
            if (status is not ("Available" or "Reserved" or "Blocked")) throw new DomainException("Invalid table status.");
            var codes = s.Tables.Where(t => Str(t["id"]) != id).Select(t => Str(t["code"])).ToHashSet();
            var code = Values.Truthy(item["code"]) ? Str(item["code"])! : Ids.ShortCode();
            while (codes.Contains(code)) code = Ids.ShortCode();
            item["event"] = ev["id"]!.DeepClone();
            item["seats"] = Values.Whole(v["seats"], 1, 30, "Seats must be a whole number.");
            item["status"] = status;
            item["token"] = Values.Truthy(item["token"]) ? item["token"]!.DeepClone() : Ids.Uid();
            item["code"] = code;
        }

        if (old is not null) collection[collection.IndexOf(old)] = item;
        else collection.Add(item);
    }

    private static void Delete(Workspace s, JsonObject v)
    {
        var kind = Str(v["kind"]);
        var collection = kind switch
        {
            "event" => s.Events, "menu" => s.Menu, "table" => s.Tables, "waiter" => s.Waiters, "inventory" => s.Inventory, _ => null,
        };
        var id = Str(v["id"]);
        if (collection is null || !collection.Any(a => Str(a["id"]) == id)) throw new DomainException("This item no longer exists in your workspace.");
        if (kind == "event" && (s.Bookings.Any(b => Str(b["event"]) == id) || s.Tables.Any(t => Str(t["event"]) == id)))
            throw new DomainException("This concert has bookings or tables. Unpublish it instead of deleting it.");
        if (kind == "waiter" && s.Orders.Any(o => Str(o["waiter"]) == id))
            throw new DomainException("This waiter has orders. Mark them inactive instead of deleting, so tip reports stay complete.");
        collection.RemoveAll(a => Str(a["id"]) == id);
        if (kind == "event")
            foreach (var item in s.Menu)
                item["events"] = new JsonArray([.. (item["events"] as JsonArray ?? []).Where(e => Str(e) != id).Select(e => e?.DeepClone())]);
    }

    private static void CheckIn(JsonObject? b, JsonObject? ticket, string? by)
    {
        if (b is null) throw new DomainException("Ticket is invalid.");
        if (Str(b["status"]) == "Cancelled") throw new DomainException("This booking was cancelled.");
        if (!Values.Truthy(b["paid"])) throw new DomainException("Take payment for this booking before checking the guest in.");
        var all = (b["tickets"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var tickets = ticket is not null ? [ticket] : all.Where(t => !Values.Truthy(t["used"])).ToList();
        if (tickets.Count == 0 || tickets.All(t => Values.Truthy(t["used"]))) throw new DomainException("This ticket has already been checked in.");
        foreach (var t in tickets)
        {
            t["used"] = true;
            t["usedAt"] = Ids.Now();
            t["usedBy"] = by ?? "";
        }
        if (all.All(t => Values.Truthy(t["used"]))) b["status"] = "Checked in";
    }

    private static void CheckInTicket(Workspace s, JsonObject v, string? by)
    {
        var value = (v.ContainsKey("code") ? Values.Show(v["code"]) : "").Trim();
        var parts = value.Split(':');
        JsonObject? b, ticket = null;
        if (parts.Length == 3) // scanned QR: REF:serial:token
        {
            b = s.Bookings.FirstOrDefault(b => Str(b["ref"]) == parts[0]);
            ticket = (b?["tickets"] as JsonArray ?? []).OfType<JsonObject>()
                .FirstOrDefault(t => Values.SameSecret(Str(t["token"]) ?? "", parts[2]));
        }
        else // typed reference number, e.g. EN-ABC123 or ABC123: admits the next ticket not yet used
        {
            var reference = value.ToUpperInvariant().Replace(" ", "");
            if (!reference.StartsWith("EN-", StringComparison.Ordinal)) reference = "EN-" + reference;
            b = s.Bookings.FirstOrDefault(b => Str(b["ref"]) == reference);
            if (b is not null)
            {
                ticket = (b["tickets"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(t => !Values.Truthy(t["used"]));
                if (ticket is null)
                {
                    var qty = Values.Decimal(b["qty"]);
                    throw new DomainException($"All {Values.Show(b["qty"])} ticket{(qty > 1 ? "s" : "")} on {reference} have already been checked in.");
                }
            }
        }
        if (ticket is null) throw new DomainException("No ticket found for that QR code or reference number.");
        CheckIn(b, ticket, by);
        v["result"] = new JsonObject
        {
            ["name"] = b!["name"]?.DeepClone(),
            ["event"] = b["eventName"]?.DeepClone(),
            ["serial"] = ticket["serial"]?.DeepClone(),
            ["qty"] = b["qty"]?.DeepClone(),
            ["ref"] = b["ref"]?.DeepClone(),
            ["remaining"] = (b["tickets"] as JsonArray ?? []).OfType<JsonObject>().Count(t => !Values.Truthy(t["used"])),
        };
    }

    private static void SaveWaiter(Workspace s, JsonObject v)
    {
        var old = s.Waiters.FirstOrDefault(w => Str(w["id"]) == Str(v["id"]));
        if (Values.Truthy(v["id"]) && old is null) throw new DomainException("This waiter no longer exists in your workspace.");
        var w = old?.DeepClone().AsObject() ?? new JsonObject { ["id"] = Ids.Uid(), ["number"] = WaiterNumber(s), ["created"] = Ids.Now() };
        w["name"] = Values.Text(v["name"], 80);
        w["phone"] = Values.Text(v["phone"], 30, false);
        w["active"] = Values.Flag(v.ContainsKey("active") ? v["active"] : true);
        if (Values.Truthy(v["regenerate"]) && old is not null) w["number"] = WaiterNumber(s);
        if (old is not null) s.Waiters[s.Waiters.IndexOf(old)] = w;
        else s.Waiters.Add(w);
        v["result"] = new JsonObject { ["id"] = w["id"]!.DeepClone(), ["number"] = w["number"]!.DeepClone(), ["name"] = w["name"]!.DeepClone() };
    }

    /// <summary>A random 4-digit waiter number that no current or past waiter in this workspace uses.</summary>
    public static string WaiterNumber(Workspace s)
    {
        var taken = s.Waiters.Select(w => Str(w["number"])).ToHashSet();
        if (taken.Count >= 9000) throw new DomainException("No waiter numbers are left.");
        while (true)
        {
            var n = (1000 + Ids.Below(9000)).ToString(CultureInfo.InvariantCulture);
            if (!taken.Contains(n)) return n;
        }
    }

    private static void AdjustMenuStock(Workspace s, JsonObject v, string? by)
    {
        var item = s.Menu.FirstOrDefault(i => Str(i["id"]) == Str(v["id"])) ?? throw new DomainException("This menu item no longer exists.");
        if (!Values.Truthy(item["trackStock"])) throw new DomainException("Turn on stock tracking for this item first.");
        var mode = Str(v["mode"]);
        var qty = Values.Whole(v["qty"], 0, 1_000_000, "Enter a whole quantity.");
        var reason = Values.Text(v["reason"], 120, false);
        var stock = Values.Long(item["stock"]);
        long change;
        switch (mode)
        {
            case "add":
                if (qty <= 0) throw new DomainException("Enter how many units arrived.");
                change = qty;
                break;
            case "remove":
                if (qty <= 0 || qty > stock) throw new DomainException($"Remove between 1 and {Values.Show(item["stock"])} units.");
                change = -qty;
                break;
            case "set":
                change = qty - stock;
                break;
            default:
                throw new DomainException("Choose add, remove or count.");
        }
        item["stock"] = stock + change;
        var fallback = mode switch { "add" => "Delivery", "remove" => "Waste or breakage", _ => "Stock count" };
        StockLog(s, item, change, reason.Length > 0 ? reason : fallback, by);
    }

    private static void SaveStoreItem(Workspace s, JsonObject v, string? by)
    {
        var old = s.Inventory.FirstOrDefault(i => Str(i["id"]) == Str(v["id"]));
        if (Values.Truthy(v["id"]) && old is null) throw new DomainException("This store item no longer exists.");
        var item = old?.DeepClone().AsObject() ?? new JsonObject { ["id"] = Ids.Uid(), ["quantity"] = 0, ["created"] = Ids.Now() };
        var category = Values.Text(v["category"], 40);
        var unit = Values.Text(v["unit"], 20);
        if (!(s.Settings["store"]!["categories"] as JsonArray ?? []).Any(c => Str(c) == category))
            throw new DomainException("Choose a category from your stock categories.");
        if (!SettingsRules.StoreUnits.Contains(unit)) throw new DomainException("Choose a unit.");
        item["name"] = Values.Text(v["name"], 80);
        item["category"] = category;
        item["unit"] = unit;
        item["supplier"] = Values.Text(v["supplier"], 80, false);
        item["reorderLevel"] = Quantity(v.ContainsKey("reorderLevel") ? v["reorderLevel"] : 0);
        item["cost"] = Values.MoneyCents(v.ContainsKey("cost") ? v["cost"] : 0, 100_000_000, "Enter a valid cost per unit.");
        var name = Str(item["name"])!;
        if (s.Inventory.Any(i => (Str(i["name"]) ?? "").ToLowerInvariant() == name.ToLowerInvariant() && Str(i["id"]) != Str(item["id"])))
            throw new DomainException($"{name} is already in your store.");
        if (old is null)
        {
            var opening = Quantity(v.ContainsKey("quantity") ? v["quantity"] : 0);
            s.Inventory.Add(item);
            StoreLog(s, item, opening, "Opening count", by);
        }
        else
        {
            s.Inventory[s.Inventory.IndexOf(old)] = item;
        }
    }

    private static void AdjustStoreItem(Workspace s, JsonObject v, string? by)
    {
        var item = s.Inventory.FirstOrDefault(i => Str(i["id"]) == Str(v["id"])) ?? throw new DomainException("This store item no longer exists.");
        var mode = Str(v["mode"]);
        var qty = Quantity(v["qty"]);
        var note = Values.Text(v["note"], 120, false);
        if (mode is "add" or "use" or "waste" && qty <= 0) throw new DomainException("Enter a quantity greater than zero.");
        var have = (double)Values.Decimal(item["quantity"]);
        double change;
        switch (mode)
        {
            case "add":
                change = qty;
                if (v["cost"] is { } cost && !(Str(cost) is "")) item["cost"] = Values.MoneyCents(cost, 100_000_000, "Enter a valid cost per unit.");
                break;
            case "use" or "waste":
                if (qty > have) throw new DomainException($"Only {Values.PyG(have)} {Values.Show(item["unit"])} in the store.");
                change = -qty;
                break;
            case "set":
                change = Math.Round(qty - have, 3, MidpointRounding.ToEven);
                break;
            default:
                throw new DomainException("Choose delivery, used, waste or count.");
        }
        var label = mode switch { "add" => "Delivery", "use" => "Used in kitchen/bar", "waste" => "Waste or breakage", _ => "Stock count" };
        StoreLog(s, item, change, note.Length > 0 ? $"{label} · {note}" : label, by);
    }

    public static JsonObject StaffOrder(Workspace s, JsonObject v)
    {
        var request = v.DeepClone().AsObject();
        request["kind"] = "menu";
        var q = Pricing.QuoteOrder(s, request, staff: true);
        var method = Values.Truthy(v["method"]) ? Values.Show(v["method"]) : "";
        if (method.Length > 0 && !StaffPaymentMethods.Contains(method)) throw new DomainException("Choose cash, card at the venue, or not paid yet.");
        var table = s.Tables.FirstOrDefault(t => Str(t["id"]) is { } tid && tid == Str(v["tableId"]));
        var name = Values.Text(v["name"], 80, false);
        var firstPublished = s.Events.Where(e => Values.Truthy(e["published"])).OrderBy(e => Str(e["date"]), StringComparer.Ordinal).FirstOrDefault();
        var rec = new JsonObject
        {
            ["id"] = Ids.Uid(), ["ref"] = Ids.Reference(), ["token"] = Ids.Uid(), ["guest"] = null,
            ["name"] = name.Length > 0 ? name : "Walk-in guest", ["phone"] = "", ["email"] = "", ["currency"] = s.Currency,
            ["total"] = q["total"]!.DeepClone(), ["subtotal"] = q["subtotal"]!.DeepClone(), ["lines"] = q["lines"]!.DeepClone(),
            ["tax"] = q["tax"]?.DeepClone(), ["tin"] = q["tin"]?.DeepClone(), ["vatNumber"] = q["vatNumber"]?.DeepClone(),
            ["tip"] = q["tip"]!.DeepClone(), ["service"] = q["service"]?.DeepClone(), ["tableName"] = q["tableName"]?.DeepClone(),
            ["event"] = Values.Truthy(q["tableEvent"]) ? q["tableEvent"]!.DeepClone() : firstPublished?["id"]?.DeepClone(),
            ["table"] = table?["id"]?.DeepClone(), ["status"] = "Placed", ["paid"] = false, ["settlement"] = "staff",
            ["takenBy"] = Str(v["_by"]) ?? "", ["created"] = Ids.Now(), ["items"] = Items(q),
        };
        TakeStock(s, (JsonArray)q["lines"]!, Str(rec["ref"])!, Str(v["_by"]));
        AttachWaiter(s, rec, q);
        if (method.Length > 0)
        {
            rec["paid"] = true;
            rec["settledBy"] = method;
            rec["settledAt"] = rec["created"]!.DeepClone();
        }
        s.Orders.Add(rec);
        return new JsonObject { ["ref"] = rec["ref"]!.DeepClone(), ["id"] = rec["id"]!.DeepClone(), ["total"] = rec["total"]!.DeepClone() };
    }

    /// <summary>
    /// A booking or table order for a signed-in guest. Records are never marked paid here: cash records stay unpaid
    /// until staff take the money and record it, and online payment is not connected yet.
    /// </summary>
    public static JsonObject GuestRecord(Workspace s, JsonObject v, JsonObject guest, bool cash)
    {
        var pay = s.Settings["payments"]!;
        var booking = Str(v["kind"]) == "booking";
        if (!cash) throw new DomainException(booking ? "Tickets are paid online only." : "Orders are paid online only.");
        if (booking && !Values.Truthy(pay["ticketCash"])) throw new DomainException("This organizer only accepts online payment for tickets.");
        if (!booking && !Values.Truthy(pay["cash"])) throw new DomainException("This organizer only accepts online payment for orders.");
        var q = Pricing.QuoteOrder(s, v, Str(guest["id"]));
        var rec = new JsonObject
        {
            ["id"] = Ids.Uid(), ["ref"] = Ids.Reference(), ["token"] = Ids.Uid(), ["guest"] = guest["id"]!.DeepClone(),
            ["name"] = guest["name"]!.DeepClone(), ["phone"] = guest["phone"]!.DeepClone(), ["email"] = Values.Email(v["email"], false),
            ["currency"] = s.Currency, ["total"] = q["total"]!.DeepClone(), ["subtotal"] = q["subtotal"]!.DeepClone(),
            ["lines"] = q["lines"]!.DeepClone(), ["tax"] = q["tax"]?.DeepClone(), ["tin"] = q["tin"]?.DeepClone(),
            ["vatNumber"] = q["vatNumber"]?.DeepClone(), ["paid"] = false, ["settlement"] = "venue", ["created"] = Ids.Now(),
        };
        if (booking)
        {
            var e = s.Events.First(e => Str(e["id"]) == Str(v["event"]));
            var qty = (int)Values.Long(q["lines"]![0]!["qty"]);
            rec["event"] = e["id"]!.DeepClone();
            rec["eventName"] = e["name"]?.DeepClone();
            rec["venue"] = e["venue"]?.DeepClone() ?? "";
            rec["date"] = e["date"]?.DeepClone() ?? "";
            rec["qty"] = qty;
            rec["status"] = "Reserved";
            rec["settlement"] = "cash";
            rec["tickets"] = new JsonArray([.. Enumerable.Range(1, qty).Select(i => (JsonNode?)new JsonObject { ["serial"] = i, ["token"] = Ids.Uid(), ["used"] = false })]);
            s.Bookings.Add(rec);
        }
        else
        {
            TakeStock(s, (JsonArray)q["lines"]!, Str(rec["ref"])!, null);
            rec["tip"] = q["tip"]!.DeepClone();
            rec["tableName"] = q["tableName"]?.DeepClone();
            rec["event"] = q["tableEvent"]?.DeepClone();
            rec["status"] = "Placed";
            rec["service"] = q["service"]?.DeepClone();
            rec["items"] = Items(q);
            AttachWaiter(s, rec, q);
            if (Values.Truthy(v["table"])) rec["table"] = Pricing.FindTable(s, token: Values.Show(v["table"]))!["id"]!.DeepClone();
            rec["settlement"] = "cash"; // unpaid until staff record the cash payment
            s.Orders.Add(rec);
        }
        return rec;
    }

    private static string Items(JsonObject q) =>
        string.Join(", ", ((JsonArray)q["lines"]!).Select(l => $"{Values.Show(l!["qty"])} × {Values.Show(l["name"])}"));

    private static void AttachWaiter(Workspace s, JsonObject rec, JsonObject q)
    {
        if (q["waiter"] is not JsonObject chosen) return;
        var w = s.Waiters.First(w => Str(w["id"]) == Str(chosen["id"]));
        rec["waiter"] = w["id"]!.DeepClone();
        rec["waiterName"] = w["name"]!.DeepClone();
        rec["waiterNumber"] = w["number"]!.DeepClone();
    }

    /// <summary>Check every tracked line first, then deduct, so an order never half-reserves stock.</summary>
    private static void TakeStock(Workspace s, JsonArray lines, string reference, string? by)
    {
        foreach (var line in lines)
        {
            var item = s.Menu.FirstOrDefault(i => Str(i["id"]) is { } iid && iid == Str(line!["id"]));
            var qty = Values.Decimal(line!["qty"]);
            if (item is not null && Values.Truthy(item["trackStock"]) && Values.Decimal(item["stock"]) < qty)
                throw new DomainException(Values.Decimal(item["stock"]) > 0
                    ? $"Only {Values.Show(item["stock"])} {Values.Show(item["name"])} left."
                    : $"{Values.Show(item["name"])} is sold out.");
        }
        foreach (var line in lines)
        {
            var item = s.Menu.FirstOrDefault(i => Str(i["id"]) is { } iid && iid == Str(line!["id"]));
            if (item is null || !Values.Truthy(item["trackStock"])) continue;
            var qty = Values.Long(line!["qty"]);
            item["stock"] = Values.Long(item["stock"]) - qty;
            StockLog(s, item, -qty, $"Order {reference}", by);
        }
    }

    private static void Restock(Workspace s, JsonObject rec, string reason, string? by)
    {
        foreach (var line in rec["lines"] as JsonArray ?? [])
        {
            var item = s.Menu.FirstOrDefault(i => Str(i["id"]) is { } iid && iid == Str(line!["id"]));
            if (item is null || !Values.Truthy(item["trackStock"])) continue;
            var qty = Values.Long(line!["qty"]);
            item["stock"] = Values.Long(item["stock"]) + qty;
            StockLog(s, item, qty, reason, by);
        }
    }

    private static void StockLog(Workspace s, JsonObject item, long change, string reason, string? by)
    {
        var opening = reason == "Opening count";
        if (change == 0 && !opening) return;
        var stock = item["stock"] is null ? 0 : Values.Long(item["stock"]);
        s.StockLog.Add(new JsonObject
        {
            ["id"] = Ids.Uid(), ["item"] = item["id"]!.DeepClone(), ["name"] = item["name"]!.DeepClone(), ["change"] = change,
            ["after"] = opening ? stock + change : stock, ["reason"] = reason, ["by"] = by ?? "", ["at"] = Ids.Now(),
        });
        TrimLog(s);
    }

    /// <summary>Apply and record a change to a store item (ingredients and supplies such as beer, bread or meat).</summary>
    private static void StoreLog(Workspace s, JsonObject item, double change, string reason, string? by)
    {
        var current = item["quantity"] is null ? 0 : (double)Values.Decimal(item["quantity"]);
        var after = Math.Round(current + change, 3, MidpointRounding.ToEven);
        item["quantity"] = after;
        s.StockLog.Add(new JsonObject
        {
            ["id"] = Ids.Uid(), ["store"] = true, ["item"] = item["id"]!.DeepClone(), ["name"] = item["name"]!.DeepClone(),
            ["unit"] = item["unit"]!.DeepClone(), ["change"] = Math.Round(change, 3, MidpointRounding.ToEven), ["after"] = after,
            ["reason"] = reason, ["by"] = by ?? "", ["at"] = Ids.Now(),
        });
        TrimLog(s);
    }

    private static void TrimLog(Workspace s)
    {
        if (s.StockLog.Count > StockLogLimit) s.StockLog.RemoveRange(0, s.StockLog.Count - StockLogLimit);
    }

    private static double Quantity(JsonNode? v) =>
        Math.Round(Values.Number(v is null || Str(v) is "" ? 0 : v, 0, 10_000_000), 3, MidpointRounding.ToEven);

    // Catalog prices are typed in currency units; the stored price is whole cents.
    private static long PriceCents(JsonNode? v) => (long)Math.Round(Values.Number(v) * 100, MidpointRounding.ToEven);

    private static string Category(Workspace s, JsonNode? value)
    {
        var name = Values.Text(value, 60);
        return (s.Settings["menu"]!["categories"] as JsonArray ?? []).Select(Str)
            .FirstOrDefault(c => c is not null && c.ToLowerInvariant() == name.ToLowerInvariant())
            ?? throw new DomainException("Choose a category from Settings → Menu categories.");
    }

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\z")] private static partial Regex EventDate();
}
