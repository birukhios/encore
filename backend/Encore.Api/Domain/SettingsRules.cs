using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Encore.Api.Persistence;
using static Encore.Api.Domain.WorkspaceRules;

namespace Encore.Api.Domain;

/// <summary>Validates and applies one settings group (Settings screens in the organizer admin).</summary>
public static partial class SettingsRules
{
    public static readonly string[] StoreUnits =
        ["bottles", "cans", "crates", "kegs", "kg", "g", "liters", "ml", "loaves", "pieces", "packs", "boxes", "bags", "trays", "dozen"];

    public static Workspace Configure(Workspace s, JsonNode? groupNode, JsonNode? values)
    {
        var group = Str(groupNode);
        if (group is null || !SettingsGroups.Contains(group)) throw new DomainException("Unknown settings section.");
        if (values is not JsonObject v) throw new DomainException("Invalid settings.");
        var cfg = (JsonObject)s.Settings[group]!;
        switch (group)
        {
            case "theme":
            {
                var accent = Values.Show(v.ContainsKey("accent") ? v["accent"] : cfg["accent"]);
                if (!AccentPattern().IsMatch(accent)) throw new DomainException("Choose a valid accent color.");
                if (ContrastWithWhite(accent) < 3) throw new DomainException("That accent is too light for white button text. Choose a deeper color.");
                var mode = Str(v.ContainsKey("mode") ? v["mode"] : cfg["mode"]);
                if (mode is not ("light" or "dark" or "system")) throw new DomainException("Choose light, dark or system appearance.");
                var adminMode = Str(v.ContainsKey("adminMode") ? v["adminMode"] : cfg["adminMode"] ?? "light");
                if (adminMode is not ("light" or "dark" or "system"))
                    throw new DomainException("Choose light, dark or system appearance for the dashboard.");
                var logo = CleanImage(v["logo"] ?? "");
                var cover = CleanImage(v["cover"] ?? "");
                cfg["accent"] = accent.ToUpperInvariant();
                cfg["mode"] = mode;
                cfg["adminMode"] = adminMode;
                cfg["logo"] = logo;
                cfg["cover"] = cover;
                break;
            }
            case "ticketing":
            {
                var enabled = Values.Flag(v["enabled"]);
                var showRemaining = Values.Flag(v["showRemaining"]);
                var max = Values.Whole(Or(v, "maxPerOrder", cfg), 1, 20, "Tickets per order must be between 1 and 20.");
                cfg["enabled"] = enabled;
                cfg["showRemaining"] = showRemaining;
                cfg["maxPerOrder"] = max;
                break;
            }
            case "ordering":
                cfg["enabled"] = Values.Flag(v["enabled"]);
                cfg["requireScan"] = Values.Flag(v["requireScan"]);
                cfg["ticketHoldersOnly"] = Values.Flag(v["ticketHoldersOnly"]);
                cfg["eventMenus"] = Values.Flag(v["eventMenus"]);
                if (Values.Truthy(cfg["ticketHoldersOnly"]) && !Values.Truthy(cfg["requireScan"]))
                    throw new DomainException("Ticket-holder ordering needs table scanning, so Encore knows which concert the guest is at.");
                break;
            case "tips":
            {
                var raw = Or(v, "presets", cfg);
                if (Str(raw) is { } typed)
                    raw = new JsonArray([.. PresetSeparators().Split(typed).Where(p => p.Length > 0).Select(p => (JsonNode?)JsonValue.Create(p))]);
                if (raw is not JsonArray list || list.Count > 5) throw new DomainException("Offer up to five tip options.");
                var presets = list.Select(p => Values.Whole(p, 1, 50000, "Tip options must be whole amounts from 1 to 50,000.")).Distinct().Order().ToList();
                var enabled = Values.Flag(Or(v, "enabled", cfg));
                var custom = Values.Flag(v["custom"]);
                cfg["enabled"] = enabled;
                cfg["custom"] = custom;
                cfg["presets"] = new JsonArray([.. presets.Select(p => (JsonNode?)p)]);
                cfg["unit"] = "amount";
                if (enabled && presets.Count == 0 && !custom) throw new DomainException("Add at least one tip option or allow custom tips.");
                break;
            }
            case "service":
            {
                // One choice for how guests reward service: tips, a service charge, both, or neither.
                var mode = Str(v["mode"]);
                if (mode is not ("tips" or "service" or "both" or "none")) throw new DomainException("Choose tips, a service charge, both, or neither.");
                var rate = Values.Number(Or(v, "rate", cfg), 0, 30);
                if (mode is "service" or "both" && rate <= 0) throw new DomainException("Enter a service charge between 0.5% and 30%.");
                cfg["enabled"] = mode is "service" or "both";
                cfg["rate"] = Math.Round(rate, 2, MidpointRounding.ToEven);
                var tips = (JsonObject)s.Settings["tips"]!;
                tips["enabled"] = mode is "tips" or "both";
                if (Values.Truthy(tips["enabled"]) && !Values.Truthy(tips["presets"]) && !Values.Truthy(tips["custom"])) tips["custom"] = true;
                break;
            }
            case "payments":
            {
                var venue = Values.Flag(Or(v, "venue", cfg));
                var cash = Values.Flag(Or(v, "cash", cfg));
                var ticketCash = Values.Flag(Or(v, "ticketCash", cfg));
                cfg["venue"] = venue;
                cfg["cash"] = cash;
                cfg["ticketCash"] = ticketCash;
                break;
            }
            case "notifications":
                cfg["smsBookings"] = Values.Flag(v["smsBookings"]);
                cfg["smsOrderReady"] = Values.Flag(v["smsOrderReady"]);
                cfg["staffNewOrders"] = Values.Flag(v["staffNewOrders"]);
                break;
            case "support":
            {
                var faqNode = v.ContainsKey("faq") ? v["faq"] : new JsonArray();
                if (faqNode is not JsonArray faq || faq.Count > 20) throw new DomainException("Add up to 20 help questions.");
                var clean = new JsonArray();
                foreach (var entry in faq)
                {
                    if (entry is not JsonObject e) throw new DomainException("Invalid help question.");
                    var q = Values.Text(e["q"], 150, false);
                    var a = Values.Text(e["a"], 1000, false);
                    if (q.Length > 0 || a.Length > 0)
                    {
                        if (q.Length == 0 || a.Length == 0) throw new DomainException("Each help question needs both a question and an answer.");
                        clean.Add(new JsonObject { ["q"] = q, ["a"] = a });
                    }
                }
                var email = Values.Email(v["email"], false);
                var phone = Values.Text(v["phone"], 30, false);
                var hours = Values.Text(v["hours"], 120, false);
                cfg["email"] = email;
                cfg["phone"] = phone;
                cfg["hours"] = hours;
                cfg["faq"] = clean;
                break;
            }
            case "profile":
            {
                var photosNode = v.ContainsKey("photos") ? v["photos"] : new JsonArray();
                if (photosNode is not JsonArray photos || photos.Count > 500) throw new DomainException("That is a lot of photos — keep it under 500.");
                var mapUrl = Values.Text(v["mapUrl"], 500, false);
                if (mapUrl.Length > 0 && !mapUrl.StartsWith("https://", StringComparison.Ordinal))
                    throw new DomainException("The map link must start with https://");
                if (mapUrl.Length > 0 && !GoogleMaps().IsMatch(mapUrl))
                    throw new DomainException("Use a Google Maps link (google.com/maps or maps.app.goo.gl).");
                var city = Values.Text(v["city"], 80, false);
                var address = Values.Text(v["address"], 200, false);
                var clean = new JsonArray([.. photos.Where(Values.Truthy).Select(CleanImage)]);
                cfg["city"] = city;
                cfg["address"] = address;
                cfg["mapUrl"] = mapUrl;
                cfg["photos"] = clean;
                break;
            }
            case "menu" or "store":
            {
                var (noun, collection) = group == "menu" ? ("menu", s.Menu) : ("stock", s.Inventory);
                var rawNode = v.ContainsKey("categories") ? v["categories"] : new JsonArray();
                if (rawNode is not JsonArray raw || raw.Count is < 1 or > 30) throw new DomainException($"Keep between 1 and 30 {noun} categories.");
                var categories = new List<string>();
                foreach (var entry in raw)
                {
                    var name = Values.Text(entry, 60);
                    if (categories.Any(c => c.ToLowerInvariant() == name.ToLowerInvariant())) throw new DomainException($"\"{name}\" is listed twice.");
                    categories.Add(name);
                }
                var renamesNode = Values.Truthy(v["renames"]) ? v["renames"] : new JsonObject();
                if (renamesNode is not JsonObject renames) throw new DomainException("Invalid category changes.");
                foreach (var item in collection)
                {
                    var current = Str(item["category"]);
                    if (current is not null && renames.ContainsKey(current)) item["category"] = renames[current]?.DeepClone();
                }
                var inUse = collection.Select(i => Str(i["category"]) ?? "None").Where(c => !categories.Contains(c))
                    .Distinct().Order(StringComparer.Ordinal).ToList();
                if (inUse.Count > 0) throw new DomainException($"Move {noun} items out of {string.Join(", ", inUse)} before removing it.");
                cfg["categories"] = new JsonArray([.. categories.Select(c => (JsonNode?)c)]);
                break;
            }
            case "tax":
            {
                var regime = Str(Or(v, "regime", cfg));
                if (!TaxRegimes.Contains(regime)) throw new DomainException("Choose VAT or no tax.");
                var tin = Values.Text(v["tin"], 20, false);
                if (tin.Length > 0 && !Tin().IsMatch(tin)) throw new DomainException("An Ethiopian TIN has 10 digits.");
                var vatRate = Values.Number(Or(v, "vatRate", cfg), 0, 50);
                var included = Values.Flag(v["pricesIncludeTax"]);
                var vatNumber = Values.Text(v["vatNumber"], 30, false);
                var tickets = Values.Flag(v["tickets"]);
                var menu = Values.Flag(v["menu"]);
                cfg["regime"] = regime;
                cfg["vatRate"] = vatRate;
                cfg["pricesIncludeTax"] = included;
                cfg["tin"] = tin;
                cfg["vatNumber"] = vatNumber;
                cfg["tickets"] = tickets;
                cfg["menu"] = menu;
                if (regime != "none" && tin.Length == 0) throw new DomainException("Enter your 10-digit TIN to show tax on receipts.");
                break;
            }
            case "legal":
            {
                var terms = Values.Text(v["terms"], 20000, false);
                var privacy = Values.Text(v["privacy"], 20000, false);
                cfg["terms"] = terms;
                cfg["privacy"] = privacy;
                break;
            }
        }
        return s;
    }

    /// <summary>Only images Encore stored itself may be shown; anything else could point at another site.</summary>
    public static JsonNode CleanImage(JsonNode? v)
    {
        if (Values.Truthy(v) && !UploadPath().IsMatch(Values.Show(v))) throw new DomainException("Upload an image first.");
        return Values.Truthy(v) ? v!.DeepClone() : "";
    }

    /// <summary>WCAG contrast of a #RRGGBB colour against white text.</summary>
    public static double ContrastWithWhite(string hex)
    {
        static double Channel(int c)
        {
            var x = c / 255.0;
            return x <= 0.03928 ? x / 12.92 : Math.Pow((x + 0.055) / 1.055, 2.4);
        }
        int Part(int i) => int.Parse(hex.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var lum = 0.2126 * Channel(Part(1)) + 0.7152 * Channel(Part(3)) + 0.0722 * Channel(Part(5));
        return 1.05 / (lum + 0.05);
    }

    // Python's v.get(key, default): a key that is present wins even when its value is null.
    private static JsonNode? Or(JsonObject v, string key, JsonObject cfg) => v.ContainsKey(key) ? v[key] : cfg[key];

    [GeneratedRegex(@"^#[0-9A-Fa-f]{6}\z")] private static partial Regex AccentPattern();
    [GeneratedRegex(@"[\s,]+")] private static partial Regex PresetSeparators();
    [GeneratedRegex(@"^https://(?:www\.)?(?:google\.[a-z.]+/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl/maps)")] private static partial Regex GoogleMaps();
    [GeneratedRegex(@"^\d{10}\z")] private static partial Regex Tin();
    [GeneratedRegex(@"^/uploads/[A-Za-z0-9_-]+\.(?:png|jpg|webp)\z")] private static partial Regex UploadPath();
}
