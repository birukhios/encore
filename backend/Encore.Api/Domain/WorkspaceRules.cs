using System.Text.Json.Nodes;
using Encore.Api.Persistence;

namespace Encore.Api.Domain;

/// <summary>A workspace's defaults, upgrades of older documents, and what guests may see of it.</summary>
public static class WorkspaceRules
{
    public static readonly string[] Currencies = ["ETB", "USD", "EUR", "KES", "NGN", "GHS", "RWF", "UGX"];
    public static readonly string[] TaxRegimes = ["vat", "none"];
    public static readonly string[] Collections = ["events", "tables", "menu", "orders", "bookings", "waiters", "stockLog", "inventory"];

    // Service charge is a percentage of the item subtotal; VAT applies to it and tips are never taxed.
    // Cash for orders and tickets is recorded by staff when the money is taken; nothing is marked paid automatically.
    // Ethiopian VAT is 15% for VAT-registered businesses; organizers confirm their own obligations.
    private const string DefaultSettingsJson = """
    {
      "theme": {"accent": "#E61E32", "mode": "light", "adminMode": "light", "logo": "", "cover": ""},
      "ticketing": {"enabled": true, "maxPerOrder": 6, "showRemaining": false},
      "ordering": {"enabled": true, "requireScan": true, "ticketHoldersOnly": true, "eventMenus": true},
      "tips": {"enabled": true, "unit": "amount", "presets": [20, 50, 100], "custom": true},
      "service": {"enabled": false, "rate": 10},
      "payments": {"venue": true, "cash": true, "ticketCash": false},
      "notifications": {"smsBookings": true, "smsOrderReady": true, "staffNewOrders": true},
      "support": {"email": "", "phone": "", "hours": "", "faq": []},
      "legal": {"terms": "", "privacy": ""},
      "profile": {"city": "Addis Ababa", "address": "", "mapUrl": "", "photos": []},
      "menu": {"categories": ["Food", "Drinks"]},
      "store": {"categories": ["Drinks", "Alcohol", "Meat", "Bakery", "Produce", "Dry goods", "Dairy", "Cleaning", "Packaging", "Other"]},
      "tax": {"regime": "vat", "vatRate": 15, "pricesIncludeTax": false, "tin": "", "vatNumber": "", "tickets": true, "menu": true, "addedOnTop": true}
    }
    """;

    public static JsonObject DefaultSettings() => JsonNode.Parse(DefaultSettingsJson)!.AsObject();

    public static IEnumerable<string> SettingsGroups => DefaultSettings().Select(p => p.Key);

    public static Workspace Blank(string name) => new()
    {
        Name = name,
        Description = "Extraordinary nights, beautifully simple.",
        Currency = "ETB",
        Settings = DefaultSettings(),
    };

    /// <summary>Bring an older workspace document up to the current shape. Idempotent.</summary>
    public static Workspace Upgrade(Workspace s)
    {
        var settings = s.Settings;
        if (settings["tax"] is JsonObject oldTax && !Values.Truthy(oldTax["addedOnTop"]))
        {
            // One-time switch for workspaces created before VAT was added on top of listed prices by default.
            oldTax["pricesIncludeTax"] = false;
            oldTax["addedOnTop"] = true;
        }
        foreach (var (group, defaults) in DefaultSettings())
        {
            if (settings[group] is not JsonObject current) settings[group] = current = [];
            foreach (var (key, value) in defaults!.AsObject())
                if (!current.ContainsKey(key)) current[key] = value!.DeepClone();
        }

        var codes = s.Tables.Select(t => Str(t["code"])).ToHashSet();
        foreach (var t in s.Tables.Where(t => string.IsNullOrEmpty(Str(t["code"]))))
        {
            var code = Ids.ShortCode();
            while (codes.Contains(code)) code = Ids.ShortCode();
            t["code"] = code;
            codes.Add(code);
        }

        var tips = (JsonObject)settings["tips"]!;
        if (Str(tips["unit"]) != "amount") // older workspaces stored percentage presets
        {
            tips["unit"] = "amount";
            tips["presets"] = new JsonArray(20, 50, 100);
        }
        var tax = (JsonObject)settings["tax"]!;
        if (!TaxRegimes.Contains(Str(tax["regime"]))) tax["regime"] = "none"; // turnover tax was removed
        tax.Remove("totRate");

        var storeCategories = (JsonArray)settings["store"]!["categories"]!;
        foreach (var item in s.Inventory)
        {
            var category = Str(item["category"]);
            if (!string.IsNullOrEmpty(category) && !storeCategories.Any(c => Str(c) == category)) storeCategories.Add(category);
        }
        var menuCategories = (JsonArray)settings["menu"]!["categories"]!;
        foreach (var item in s.Menu)
        {
            if (!item.ContainsKey("events")) item["events"] = new JsonArray();
            if (!item.ContainsKey("trackStock")) item["trackStock"] = false;
            if (!item.ContainsKey("stock")) item["stock"] = 0;
            if (!item.ContainsKey("lowStock")) item["lowStock"] = 5;
            var category = Str(item["category"]);
            if (!string.IsNullOrEmpty(category) && !menuCategories.Any(c => Str(c) == category)) menuCategories.Add(category);
        }
        return s;
    }

    public static JsonObject PublicSettings(Workspace s)
    {
        string[] keep = ["theme", "ticketing", "ordering", "tips", "service", "payments", "support", "legal", "profile", "menu", "tax"];
        var output = new JsonObject();
        foreach (var k in keep) output[k] = s.Settings[k]?.DeepClone();
        return output;
    }

    /// <summary>Google Maps link for the organizer: the saved link, or a search for the address and city.</summary>
    public static string MapLink(Workspace s)
    {
        var p = s.Settings["profile"]!;
        var saved = Str(p["mapUrl"]);
        if (!string.IsNullOrEmpty(saved)) return saved;
        var address = Str(p["address"]);
        var city = Str(p["city"]);
        if (string.IsNullOrEmpty(address) && string.IsNullOrEmpty(city)) return "";
        var query = string.Join(", ", new[] { address, city, "Ethiopia" }.Where(x => !string.IsNullOrEmpty(x)));
        return "https://www.google.com/maps/search/?api=1&query=" + Uri.EscapeDataString(query).Replace("%2F", "/");
    }

    public static JsonObject PublicState(Workspace s)
    {
        var output = new JsonObject
        {
            ["name"] = s.Name,
            ["description"] = s.Description,
            ["currency"] = s.Currency,
            ["settings"] = PublicSettings(s),
            ["mapLink"] = MapLink(s),
        };
        var showRemaining = Values.Truthy(s.Settings["ticketing"]!["showRemaining"]);
        var events = new JsonArray();
        foreach (var e in s.Events.Where(e => Values.Truthy(e["published"])))
        {
            var item = Pick(e, "id", "name", "date", "venue", "description", "price", "image");
            var remaining = Math.Max(0, Values.Decimal(e["capacity"]) - Pricing.Sold(s, Str(e["id"])));
            item["soldOut"] = remaining == 0;
            if (showRemaining) item["remaining"] = remaining;
            events.Add(item);
        }
        output["events"] = events;
        var published = events.Select(e => Str(e!["id"])).ToHashSet();

        var menu = new JsonArray();
        foreach (var i in s.Menu)
        {
            var item = Pick(i, "id", "name", "description", "price", "category", "available", "image", "events");
            if (Values.Truthy(i["trackStock"]))
            {
                var stock = Values.Decimal(i["stock"]);
                item["soldOut"] = stock <= 0;
                item["available"] = Values.Truthy(i["available"]) && stock > 0;
                var low = i["lowStock"] is null ? 5 : Values.Decimal(i["lowStock"]);
                if (stock > 0 && stock <= low) item["left"] = i["stock"]!.DeepClone();
            }
            menu.Add(item);
        }
        output["menu"] = menu;
        output["waiters"] = s.Waiters.Any(w => Values.Truthy(w["active"])); // whether guests can credit a waiter; names stay private
        output["tables"] = new JsonArray([.. s.Tables.Where(t => published.Contains(Str(t["event"]))).Select(t => (JsonNode)Pick(t, "id", "name", "event", "seats", "status"))]);
        return output;
    }

    public static JsonObject Receipt(Workspace s, JsonObject rec)
    {
        string[] keep = ["ref", "token", "name", "phone", "email", "currency", "total", "subtotal", "lines", "paid", "settlement", "created",
            "status", "tip", "tableName", "items", "event", "eventName", "venue", "date", "qty", "tickets", "settledBy", "settledAt",
            "tax", "tin", "vatNumber", "service", "waiterName", "waiterNumber"];
        var output = new JsonObject();
        foreach (var k in keep) if (rec.ContainsKey(k)) output[k] = rec[k]?.DeepClone();
        if (output["tickets"] is JsonArray tickets)
            foreach (var t in tickets.OfType<JsonObject>()) t.Remove("usedBy"); // staff names stay internal
        output["merchant"] = s.Name;
        output["kind"] = rec.ContainsKey("qty") ? "booking" : "order";
        return output;
    }

    /// <summary>Only the named fields, with null for any the record lacks (as Python's dict.get did).</summary>
    public static JsonObject Pick(JsonObject source, params string[] keys)
    {
        var output = new JsonObject();
        foreach (var k in keys) output[k] = source[k]?.DeepClone();
        return output;
    }

    public static string? Str(JsonNode? v) => v is JsonValue x && x.TryGetValue(out string? s) ? s : null;
}
