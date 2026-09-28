using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Encore.Api.Tests;

/// <summary>Guests signing in, booking, ordering, paying at the venue and rating, over HTTP against the real app.</summary>
[Collection("server")]
public sealed class GuestJourneyTests(EncoreApp app) : ServerTest(app)
{
    private async Task CashOn(Client c) => await Act(c, "config", new { group = "payments", values = new { cash = true, ticketCash = true } });

    [Fact]
    public async Task Sign_in_code_rules()
    {
        var g = App.Guest();
        Assert.Equal(400, await g.Status("guest/otp", new { phone = "12" }));
        Assert.Equal(200, await g.Status("guest/otp", new { phone = "0922 000 111" }));
        Assert.Equal("+251922000111", App.Sent()[^1].Phone);
        Assert.Equal("OTP_WAIT", (string)(await g.Call("guest/otp", new { phone = "+251922000111" })).Body["code"]!);
        for (var i = 0; i < 5; i++) Assert.Equal(400, await g.Status("guest/verify", new { phone = "0922000111", code = "000000" }));
        var code = Regex.Match(App.Sent()[^1].Text, @"\b(\d{6})\b").Groups[1].Value;
        Assert.Contains("Too many", (string)(await g.Call("guest/verify", new { phone = "0922000111", code })).Body["error"]!);
        Assert.Equal("""{"guest":null}""", (await g.Call("guest/me")).Body.ToJsonString());
        Assert.Equal(401, await g.Status("order", new { tenant = "x", kind = "booking" }));
    }

    [Fact]
    public async Task Online_payment_fails_closed_and_cash_is_opt_in()
    {
        var (c, b, _, _) = await Staff();
        var t = Tenant(b);
        var e = await Concert(c);
        var (g, _) = await GuestClient("Cash Guest");
        Assert.Null((await g.Call("guest/otp", new { phone = "0944000111" })).Body["demoCode"]); // no code ever reaches the browser
        Assert.Equal("PAYMENT_NOT_CONFIGURED", (string)(await g.Call("checkout", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 1 })).Body["code"]!);
        Assert.False((bool)(await g.Call("public?tenant=" + t)).Body["paymentReady"]!);
        var (status, body) = await g.Call("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 1, payment = "cash" });
        Assert.Equal((400, "This organizer only accepts online payment for tickets."), (status, (string)body["error"]!));
        await CashOn(c);
        var (created, rec) = await g.Call("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 1, payment = "cash" });
        Assert.Equal((201, false, "cash", 11500L), (created, (bool)rec["paid"]!, (string)rec["settlement"]!, (long)rec["total"]!));
        var booking = (await State(c))["bookings"]![0]!;
        Assert.Contains("payment", (string)(await Act(c, "checkin", new { id = (string)booking["id"]! })).Body["error"]!); // pay first
        Assert.Equal(200, (await Act(c, "settle", new { id = (string)booking["id"]!, method = "Cash" })).Status);
        Assert.Equal(200, (await Act(c, "checkin", new { id = (string)booking["id"]! })).Status);
    }

    [Fact]
    public async Task Tickets_reference_check_in_and_notifications()
    {
        var (c, b, _, _) = await Staff();
        var t = Tenant(b);
        var e = await Concert(c, capacity: 3);
        var (g, _) = await GuestClient("Guest One");
        var online = await g.Call("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 2 });
        Assert.Equal((400, "Tickets are paid online only."), (online.Status, (string)online.Body["error"]!));
        await CashOn(c);
        var (status, rec) = await g.Call("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 2, payment = "cash", total = 1, paid = true });
        Assert.Equal(201, status);
        // One SMS carries a private link that opens both tickets' QR codes.
        var sms = App.Sent().Last(m => m.Text.Contains((string)rec["ref"]!)).Text;
        Assert.Contains($"view=tickets&ref={rec["ref"]}&token={rec["token"]}", sms);
        Assert.Equal((23000L, false, "Reserved", 2, "Guest One"), ((long)rec["total"]!, (bool)rec["paid"]!, (string)rec["status"]!, rec["tickets"]!.AsArray().Count, (string)rec["name"]!));
        var (g2, _) = await GuestClient();
        Assert.Equal(400, await g2.Status("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 2, payment = "cash" })); // capacity
        Assert.Equal(200, (await Act(c, "settle", new { id = (string)(await State(c))["bookings"]![0]!["id"]!, method = "Cash" })).Status);
        Assert.Empty((await g2.Call("guest/records?tenant=" + t)).Body["records"]!.AsArray()); // guests only see their own records
        Assert.Equal($"[\"{e["id"]}\"]", (await g.Call("guest/records?tenant=" + t)).Body["events"]!.ToJsonString());
        var reference = (string)rec["ref"]!;
        var ticket = (string)rec["tickets"]![0]!["token"]!;
        var (ok, scanned) = await Act(c, "checkin_ticket", new { code = $"{reference}:1:{ticket}" });
        Assert.Equal((200, 1, 1), (ok, (int)scanned["result"]!["serial"]!, (int)scanned["result"]!["remaining"]!));
        Assert.Equal(400, (await Act(c, "checkin_ticket", new { code = $"{reference}:1:{ticket}" })).Status);
        // A typed reference admits the next unused ticket; case and prefix are forgiving.
        var (typed, second) = await Act(c, "checkin_ticket", new { code = " " + reference[3..].ToLowerInvariant() + " " });
        Assert.Equal((200, 2, 0), (typed, (int)second["result"]!["serial"]!, (int)second["result"]!["remaining"]!));
        Assert.Contains("already been checked in", (string)(await Act(c, "checkin_ticket", new { code = reference })).Body["error"]!);
        Assert.Equal(400, (await Act(c, "checkin_ticket", new { code = "EN-ZZZZZZ" })).Status);
        var booking = (await State(c))["bookings"]![0]!;
        Assert.Equal("Checked in", (string)booking["status"]!);
        Assert.All(booking["tickets"]!.AsArray(), x => Assert.Equal("Test Organizer", (string)x!["usedBy"]!));
        var receipt = (await g.Call($"receipt?tenant={t}&ref={reference}&token={rec["token"]}")).Body;
        Assert.Null(receipt["tickets"]![0]!["usedBy"]); // staff names stay internal
        var (other, _, _, _) = await Staff();
        Assert.Equal(400, (await Act(other, "checkin_ticket", new { code = reference })).Status); // another workspace
        Assert.Contains((await g.Call("guest/notifications")).Body.AsArray(), n => (string)n!["title"]! == "Tickets reserved");
        Assert.Contains((await c.Call("notifications")).Body.AsArray(), n => ((string)n!["title"]!).Contains("New booking"));
    }

    [Fact]
    public async Task Table_scan_event_menus_tips_and_order_tracking()
    {
        var (c, b, _, _) = await Staff();
        var t = Tenant(b);
        // The table-scan rules, still available to organizers who want them (new workspaces have them off).
        await Act(c, "config", new { group = "ordering", values = new { enabled = true, requireScan = true, ticketHoldersOnly = true, eventMenus = true, cashierConfirm = false } });
        var e = await Concert(c, price: "0");
        var other = await Concert(c, price: "0");
        await Act(c, "menu", new { name = "Tea", description = "Hot", price = "50", category = "Drinks", available = true, events = new[] { (string)e["id"]! } });
        await Act(c, "menu", new { name = "Cake", description = "Sweet", price = "80", category = "Food", available = true, events = new[] { (string)other["id"]! } });
        var menu = (await State(c))["menu"]!.AsArray();
        await Act(c, "table", new { name = "Table 3", @event = (string)e["id"]!, seats = 4 });
        var tok = (string)(await State(c))["tables"]![0]!["token"]!;
        var (g, guest) = await GuestClient();
        var tea = new JsonObject { [(string)menu[0]!["id"]!] = 2 };
        Assert.Equal("Orders are paid online only.", (string)(await g.Call("order", new JsonObject { ["tenant"] = t, ["kind"] = "menu", ["items"] = tea.DeepClone() })).Body["error"]!);
        await CashOn(c);
        Task<(int Status, JsonNode Body)> Cash(JsonObject data)
        {
            data["tenant"] = t;
            data["payment"] = "cash";
            return g.Call("order", data);
        }
        Assert.Contains("Scan", (string)(await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone() })).Body["error"]!);
        Assert.Contains("ticket holders", (string)(await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone(), ["table"] = tok })).Body["error"]!);
        Assert.Equal(201, (await Cash(new JsonObject { ["kind"] = "booking", ["event"] = (string)e["id"]!, ["qty"] = 1 })).Status);
        Assert.Contains("not served", (string)(await Cash(new JsonObject { ["kind"] = "menu", ["items"] = new JsonObject { [(string)menu[1]!["id"]!] = 1 }, ["table"] = tok })).Body["error"]!);
        Assert.Equal(400, (await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone(), ["table"] = "forged" })).Status);
        await Act(c, "config", new { group = "tips", values = new { enabled = true, presets = new[] { 10, 50 }, custom = false } });
        Assert.Equal(400, (await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone(), ["tipAmount"] = "7", ["table"] = tok })).Status);
        foreach (var bad in new[] { "-5", "10.555", "abc" })
            Assert.Equal(400, (await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone(), ["tipAmount"] = bad, ["table"] = tok })).Status);
        var (status, rec) = await Cash(new JsonObject { ["kind"] = "menu", ["items"] = tea.DeepClone(), ["tipAmount"] = "10", ["table"] = tok });
        Assert.Equal(201, status);
        // 100.00 + 15.00 VAT + 10.00 tip
        Assert.Equal((10000L, 1000L, 12500L, "Table 3", "Placed", false),
            ((long)rec["subtotal"]!, (long)rec["tip"]!, (long)rec["total"]!, (string)rec["tableName"]!, (string)rec["status"]!, (bool)rec["paid"]!));
        var order = (await State(c))["orders"]![0]!;
        foreach (var next in new[] { "Preparing", "Ready", "Delivered" })
            Assert.Equal(200, (await Act(c, "order_status", new { id = (string)order["id"]!, status = next })).Status);
        Assert.Equal("Delivered", (string)(await g.Call($"receipt?tenant={t}&ref={rec["ref"]}&token={rec["token"]}")).Body["status"]!);
        Assert.Equal(404, await g.Status($"receipt?tenant={t}&ref={rec["ref"]}&token=wrong"));
        Assert.Contains(App.Sent(), m => m.Text.Contains("ready") && m.Phone == (string)guest["phone"]!); // "order ready" SMS
    }

    [Fact]
    public async Task Tax_categories_ratings_and_profile()
    {
        var (c, b, _, _) = await Staff();
        var t = Tenant(b);
        var e = await Concert(c, price: "115");
        await Act(c, "table", new { name = "T1", @event = (string)e["id"]!, seats = 2 });
        var tok = (string)(await State(c))["tables"]![0]!["token"]!;
        // A TIN is required once tax is on, and has 10 digits.
        Assert.Equal(400, (await Act(c, "config", new { group = "tax", values = new { regime = "vat", vatRate = 15, pricesIncludeTax = true, tin = "123", tickets = true, menu = true } })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "tax", values = new { regime = "vat", vatRate = 15, pricesIncludeTax = true, tin = "0012345678", tickets = true, menu = true } })).Status);
        var (g, _) = await GuestClient();
        var q = (await g.Call("quote", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 2 })).Body;
        Assert.Equal((23000L, 3000L, "VAT 15%", "0012345678"), ((long)q["total"]!, (long)q["tax"]!["amount"]!, (string)q["tax"]!["label"]!, (string)q["tin"]!));
        await Act(c, "config", new { group = "tax", values = new { regime = "vat", vatRate = 15, pricesIncludeTax = false, tin = "0012345678", tickets = true, menu = true } });
        await CashOn(c);
        var rec = (await g.Call("order", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 1, payment = "cash" })).Body;
        Assert.Equal((11500L, 1725L, 13225L), ((long)rec["subtotal"]!, (long)rec["tax"]!["amount"]!, (long)rec["total"]!)); // VAT added on top
        // Menu categories must exist; renames cascade; removal is blocked while in use.
        Assert.Equal(400, (await Act(c, "menu", new { name = "Tej", description = "Honey wine", price = "100", category = "Cocktails", available = true })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "menu", values = new { categories = new[] { "Food", "Drinks", "Cocktails" } } })).Status);
        Assert.Equal(200, (await Act(c, "menu", new { name = "Tej", description = "Honey wine", price = "100", category = "cocktails", available = true })).Status);
        Assert.Equal(400, (await Act(c, "config", new { group = "menu", values = new { categories = new[] { "Food", "Drinks" } } })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "menu", values = new { categories = new[] { "Food", "Drinks", "Traditional" }, renames = new { Cocktails = "Traditional" } } })).Status);
        Assert.Equal("Traditional", (string)(await State(c))["menu"]![0]!["category"]!);
        Assert.Equal(400, (await Act(c, "config", new { group = "tax", values = new { regime = "tot", pricesIncludeTax = false, tin = "0012345678", tickets = true, menu = true } })).Status);
        var item = (string)(await State(c))["menu"]![0]!["id"]!;
        var menuOrder = (await g.Call("order", new JsonObject { ["tenant"] = t, ["kind"] = "menu", ["items"] = new JsonObject { [item] = 3 }, ["tipAmount"] = "25.50", ["table"] = tok, ["payment"] = "cash" })).Body;
        Assert.Equal((30000L, "VAT 15%", 4500L, 2550L, 37050L),
            ((long)menuOrder["subtotal"]!, (string)menuOrder["tax"]!["label"]!, (long)menuOrder["tax"]!["amount"]!, (long)menuOrder["tip"]!, (long)menuOrder["total"]!));
        // Inclusive VAT with awkward amounts rounds to the cent and never changes the total.
        await Act(c, "config", new { group = "tax", values = new { regime = "vat", vatRate = 15, pricesIncludeTax = true, tin = "0012345678", tickets = true, menu = true } });
        var inclusive = (await g.Call("quote", new JsonObject { ["tenant"] = t, ["kind"] = "menu", ["items"] = new JsonObject { [item] = 1 }, ["tipAmount"] = 0, ["table"] = tok })).Body;
        Assert.Equal((10000L, 1304L, 10000L), ((long)inclusive["subtotal"]!, (long)inclusive["tax"]!["amount"]!, (long)inclusive["total"]!));
        // Ratings: only guests who booked or ordered; one per guest, updatable; shown in the directory.
        var (stranger, _) = await GuestClient();
        Assert.Equal(401, await stranger.Status("guest/rating", new { tenant = t, stars = 5 }));
        Assert.Equal(400, await g.Status("guest/rating", new { tenant = t, stars = 6 }));
        Assert.Equal(3.0, (double)(await g.Call("guest/rating", new { tenant = t, stars = 3, comment = "Good sound" })).Body["average"]!);
        var summary = (await g.Call("guest/rating", new { tenant = t, stars = 5, comment = "Great night" })).Body;
        Assert.Equal((1, 5.0, 5), ((int)summary["count"]!, (double)summary["average"]!, (int)summary["mine"]!["stars"]!));
        Assert.Equal("Great night", (string)(await g.Call("public?tenant=" + t)).Body["ratings"]!["recent"]![0]!["comment"]!);
        Assert.Equal(1, (int)(await c.Call("me")).Body["ratings"]!["count"]!);
        // Profile: location and photos appear in the organizer directory.
        var url = (string)(await c.Call("upload", new { data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=" })).Body["url"]!;
        Assert.Equal(400, (await Act(c, "config", new { group = "profile", values = new { city = "Addis Ababa", address = "Bole Road", mapUrl = "javascript:alert(1)", photos = new[] { url } } })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "profile", values = new { city = "Addis Ababa", address = "Bole Road", mapUrl = "https://maps.app.goo.gl/abc123", photos = new[] { url } } })).Status);
        Assert.Equal(400, (await Act(c, "config", new { group = "profile", values = new { city = "Addis Ababa", address = "Bole Road", mapUrl = "https://maps.example/x", photos = new[] { url } } })).Status);
        await Act(c, "config", new { group = "profile", values = new { city = "Addis Ababa", address = "Bole Road", mapUrl = "", photos = new[] { url } } });
        var org = (await App.Guest().Call("workspaces")).Body.AsArray().First(w => (string)w!["id"]! == t)!;
        Assert.Equal((url, "Bole Road", "Addis Ababa", 1, 5.0), ((string)org["photo"]!, (string)org["address"]!, (string)org["city"]!, (int)org["events"]!, (double)org["rating"]!["average"]!));
        Assert.Equal("https://www.google.com/maps/search/?api=1&query=Bole%20Road%2C%20Addis%20Ababa%2C%20Ethiopia", (string)org["mapLink"]!);
    }

    [Fact]
    public async Task Cashier_confirms_orders_placed_with_the_menu_qr_and_a_waiter_number()
    {
        var (owner, b, _, _) = await Staff();
        var t = Tenant(b);
        await Concert(owner);
        await Act(owner, "menu", new { name = "Tibs", description = "Hot", price = "100", category = "Food", available = true, trackStock = true, stock = 5, lowStock = 1 });
        await Act(owner, "waiter", new { name = "Abel Tesfaye" });
        var state = await State(owner);
        var item = (string)state["menu"]![0]!["id"]!;
        var number = (string)state["waiters"]![0]!["number"]!;

        async Task<Client> Member(string role)
        {
            var mail = Guid.NewGuid().ToString("N")[..8] + "@example.com";
            var token = ((string)(await owner.Call("invite", new { email = mail, role })).Body["url"]!).Split("invite=")[1];
            var m = App.Admin();
            Assert.Equal(201, await m.Status("signup", new { name = role + " Staff", email = mail, password = Password(), invite = token }));
            return m;
        }
        var cashier = await Member("Service");
        var gate = await Member("Gate");

        // No table scan: the guest orders from the menu QR and names the waiter.
        var (g, _) = await GuestClient("Menu Guest");
        var (status, rec) = await g.Call("order", new JsonObject { ["tenant"] = t, ["kind"] = "menu", ["items"] = new JsonObject { [item] = 2 }, ["waiter"] = number, ["payment"] = "cash" });
        Assert.Equal(201, status);
        Assert.Equal(("Awaiting cashier", false, number), ((string)rec["status"]!, (bool)rec["paid"]!, (string)rec["waiterNumber"]!));
        var order = (await State(owner))["orders"]![0]!;
        var id = (string)order["id"]!;

        // Only staff with the cashier queue may claim or confirm; the kitchen cannot start it yet.
        Assert.Equal(401, (await Act(gate, "claim", new { id })).Status);
        Assert.Equal(401, (await Act(gate, "confirm_order", new { id })).Status);
        Assert.Equal(400, (await Act(owner, "order_status", new { id, status = "Preparing" })).Status);

        Assert.Equal(200, (await Act(cashier, "claim", new { id })).Status);
        Assert.Equal("Service Staff", (string)(await State(owner))["orders"]![0]!["claimedBy"]!);
        Assert.Contains("Take the payment first", (string)(await Act(cashier, "confirm_order", new { id })).Body["error"]!);
        Assert.Equal(200, (await Act(cashier, "settle", new { id, method = "Cash" })).Status);
        Assert.Equal(200, (await Act(cashier, "confirm_order", new { id })).Status);
        var confirmed = (await State(owner))["orders"]![0]!;
        Assert.Equal(("Placed", true, "Service Staff"), ((string)confirmed["status"]!, (bool)confirmed["paid"]!, (string)confirmed["confirmedBy"]!));
        Assert.Contains((await g.Call("guest/notifications")).Body.AsArray(), n => ((string)n!["title"]!).EndsWith("Confirmed"));

        // From here the kitchen and waiter flow is unchanged; a mistaken step can be undone by staff, not the gate.
        foreach (var next in new[] { "Preparing", "Ready", "Delivered" })
            Assert.Equal(200, (await Act(cashier, "order_status", new { id, status = next })).Status);
        Assert.Equal(401, (await Act(gate, "order_back", new { id })).Status);
        Assert.Equal(200, (await Act(cashier, "order_back", new { id })).Status);
        Assert.Equal("Ready", (string)(await State(owner))["orders"]![0]!["status"]!);
        Assert.Equal(3L, (long)(await State(owner))["menu"]![0]!["stock"]!);
    }

    [Fact]
    public async Task Cashiers_see_only_their_own_orders_and_members_only_their_granted_pages()
    {
        var (owner, b, _, _) = await Staff();
        var t = Tenant(b);
        await Concert(owner);
        await Act(owner, "menu", new { name = "Tibs", description = "Hot", price = "100", category = "Food", available = true });
        var item = (string)(await State(owner))["menu"]![0]!["id"]!;

        async Task<(Client Client, string Id)> Member(string role, string[]? pages = null)
        {
            var mail = Guid.NewGuid().ToString("N")[..8] + "@example.com";
            var token = ((string)(await owner.Call("invite", new { email = mail, role, pages })).Body["url"]!).Split("invite=")[1];
            var m = App.Admin();
            var (status, body) = await m.Call("signup", new { name = role + " " + mail[..4], email = mail, password = Password(), invite = token });
            Assert.Equal(201, status);
            return (m, (string)body["user"]!["id"]!);
        }
        var (one, _) = await Member("Cashier");
        var (two, _) = await Member("Cashier");
        var (g, _) = await GuestClient("Queue Guest");
        await g.Call("order", new JsonObject { ["tenant"] = t, ["kind"] = "menu", ["items"] = new JsonObject { [item] = 1 }, ["payment"] = "cash" });
        var id = (string)(await State(owner))["orders"]![0]!["id"]!;

        Assert.Single((await State(two))["orders"]!.AsArray());
        Assert.Empty((await State(two))["bookings"]!.AsArray());
        Assert.Equal(200, (await Act(one, "claim", new { id })).Status);
        // Cashier 1 took it: cashier 2 no longer sees it and cannot take its payment or cancel it.
        Assert.Empty((await State(two))["orders"]!.AsArray());
        Assert.Equal(401, (await Act(two, "settle", new { id, method = "Cash" })).Status);
        Assert.Equal(401, (await Act(two, "cancel", new { id })).Status);
        Assert.Equal(401, (await Act(one, "order_status", new { id, status = "Preparing" })).Status);
        Assert.Equal(200, (await Act(one, "settle", new { id, method = "Cash" })).Status);
        Assert.Equal(200, (await Act(one, "confirm_order", new { id })).Status);
        Assert.Equal("Placed", (string)(await State(one))["orders"]![0]!["status"]!);
        Assert.Empty((await State(two))["orders"]!.AsArray());

        // Page access: an admin limited to Menu and Orders cannot touch events or payment settings.
        var (limited, limitedId) = await Member("Admin", ["Menu", "Orders"]);
        var pages = (await limited.Call("me")).Body["user"]!["pages"]!.AsArray().Select(p => (string)p!).Order();
        Assert.Equal(["Guide", "Menu", "Orders"], pages);
        var concert = new { name = "Late", date = "2030-01-01T20:00", venue = "Hall", price = "1", capacity = 1 };
        Assert.Equal(401, (await Act(limited, "event", concert)).Status);
        Assert.Equal(401, (await Act(limited, "config", new { group = "payments", values = new { cash = true } })).Status);
        Assert.Equal(200, (await Act(limited, "config", new { group = "menu", values = new { categories = new[] { "Food", "Drinks" } } })).Status);
        Assert.Equal(401, (await one.Call("team/access", new { id = limitedId, pages = new[] { "Events" } })).Status);
        Assert.Equal(200, (await owner.Call("team/access", new { id = limitedId, pages = new[] { "Events" } })).Status);
        Assert.NotEqual(401, (await Act(limited, "event", concert)).Status);
        Assert.Equal(401, (await Act(limited, "menu", new { name = "Tea", price = "10", category = "Drinks", available = true })).Status);
    }

    [Fact]
    public async Task Booking_capacity_and_receipt_links()
    {
        var (c, b, _, _) = await Staff();
        var e = await Concert(c, capacity: 2, price: "10.50");
        var tenant = Tenant(b);
        var (g, _) = await GuestClient();
        await CashOn(c);
        var payload = new { tenant, kind = "booking", @event = (string)e["id"]!, qty = 2, payment = "cash", paid = true, total = 1 };
        Assert.Equal(401, await App.Guest().Status("order", payload));
        var (status, rec) = await g.Call("order", payload);
        Assert.Equal(201, status);
        Assert.Equal((2100L, 315L, 2415L, false), ((long)rec["subtotal"]!, (long)rec["tax"]!["amount"]!, (long)rec["total"]!, (bool)rec["paid"]!)); // 21.00 + 15% VAT
        Assert.Equal(400, await g.Status("order", payload)); // sold out
        var path = $"receipt?tenant={tenant}&ref={rec["ref"]}&token=";
        Assert.Equal(404, await g.Status(path + "wrong"));
        Assert.Equal(200, await App.Guest().Status(path + rec["token"])); // the receipt link works without signing in
    }

    [Fact]
    public async Task Concurrent_bookings_never_oversell()
    {
        var (c, b, _, _) = await Staff();
        var e = await Concert(c, capacity: 2, price: "10.50");
        await CashOn(c);
        var guests = new[] { (await GuestClient()).Client, (await GuestClient()).Client };
        var p = new { tenant = Tenant(b), kind = "booking", @event = (string)e["id"]!, qty = 2, payment = "cash" };
        var statuses = await Task.WhenAll(guests.Select(g => g.Status("order", p)));
        Assert.Equal([201, 400], statuses.Order());
    }

    [Fact]
    public async Task Stock_waiters_and_staff_orders_over_http()
    {
        var (c, b, _, _) = await Staff();
        await Concert(c);
        await Act(c, "menu", new { name = "Tibs", description = "Hot", price = "100", category = "Food", available = true, trackStock = true, stock = 2, lowStock = 1 });
        await Act(c, "waiter", new { name = "Abel Tesfaye" });
        var state = await State(c);
        var item = (string)state["menu"]![0]!["id"]!;
        var number = (string)state["waiters"]![0]!["number"]!;
        var (status, taken) = await Act(c, "staff_order", new JsonObject { ["items"] = new JsonObject { [item] = 2 }, ["waiter"] = number, ["tipAmount"] = "10", ["method"] = "Cash", ["name"] = "Walk-in" });
        Assert.Equal(200, status);
        Assert.Equal(24000L, (long)taken["result"]!["total"]!); // 200.00 + 15% VAT + 10.00 tip
        var order = (await State(c))["orders"]![0]!;
        Assert.Equal((true, "Cash", "Test Organizer", number, 0L), ((bool)order["paid"]!, (string)order["settledBy"]!, (string)order["takenBy"]!, (string)order["waiterNumber"]!, (long)(await State(c))["menu"]![0]!["stock"]!));
        Assert.True((bool)(await App.Guest().Call("public?tenant=" + Tenant(b))).Body["menu"]![0]!["soldOut"]!);
    }

    [Fact]
    public async Task Staff_orders_take_cash_or_afropay_but_never_card()
    {
        var (c, _, _, _) = await Staff();
        await Concert(c);
        await Act(c, "menu", new { name = "Tea", description = "Hot", price = "20", category = "Food", available = true });
        var item = (string)(await State(c))["menu"]![0]!["id"]!;
        JsonObject Order(string method, string? phone = null) => new() { ["items"] = new JsonObject { [item] = 1 }, ["method"] = method, ["phone"] = phone, ["name"] = "Table guest" };

        Assert.Contains("Choose cash, Afropay", (string)(await Act(c, "staff_order", Order("Card at venue"))).Body["error"]!);
        // Afropay is not connected yet, so nothing is recorded and no payment is pretended.
        var (status, body) = await Act(c, "staff_order", Order("Afropay", "0911223344"));
        Assert.Equal(400, status);
        Assert.Contains("Afropay is not connected", (string)body["error"]!);
        Assert.Empty((await State(c))["orders"]!.AsArray());

        Assert.Equal(200, (await Act(c, "staff_order", Order("", "0911223344"))).Status);
        var order = (await State(c))["orders"]![0]!;
        Assert.Equal(("+251911223344", false), ((string)order["phone"]!, (bool)order["paid"]!));
        Assert.Equal(400, (await Act(c, "settle", new { id = (string)order["id"]!, method = "Card at venue" })).Status);
        Assert.Equal(200, (await Act(c, "settle", new { id = (string)order["id"]!, method = "Cash" })).Status);
    }
}
