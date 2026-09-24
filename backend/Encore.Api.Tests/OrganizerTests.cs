using System.Net;
using System.Text.Json.Nodes;

namespace Encore.Api.Tests;

/// <summary>Organizer accounts, workspaces, roles and settings, over HTTP against the real app.</summary>
[Collection("server")]
public sealed class OrganizerTests(EncoreApp app) : ServerTest(app)
{
    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

    [Fact]
    public async Task Account_session_signout_and_recovery()
    {
        var (c, b, mail, pw) = await Staff();
        Assert.Equal(200, await c.Status("me"));
        var anon = App.Admin();
        Assert.Equal(401, await anon.Status("signin", new { email = mail, password = "wrong" }));
        await c.Call("signout", new { });
        Assert.Equal(401, await c.Status("me"));
        var fresh = Password();
        Assert.Equal(200, await anon.Status("recover", new { email = mail, password = fresh, recovery = (string)b["recovery"]! }));
        Assert.Equal(200, await anon.Status("signin", new { email = mail, password = fresh }));
        Assert.Equal(401, await App.Admin().Status("signin", new { email = mail, password = pw }));
    }

    [Fact]
    public async Task Tenant_isolation_and_optimistic_updates()
    {
        var (a, _, _, _) = await Staff();
        var (b, bb, _, _) = await Staff();
        // The "tenant" field is ignored: staff only ever act on their own workspace.
        var v = new { op = "settings", version = 0, data = new { name = "Only A", description = "A private workspace", currency = "USD" }, tenant = Tenant(bb) };
        Assert.Equal(200, await a.Status("action", v));
        Assert.Equal("Test Workspace", (string)(await State(b))["name"]!);
        Assert.Equal(409, await a.Status("action", v)); // stale version
    }

    [Fact]
    public async Task Organizer_and_guest_apis_are_separate()
    {
        var (c, _, _, _) = await Staff();
        var g = App.Guest();
        g.Cookies = new(c.Cookies);
        Assert.Equal(404, await g.Status("me"));
        Assert.Equal(404, await g.Status("action", new { op = "settings", version = 0, data = new { } }));
        Assert.Equal(404, await App.Admin().Status("guest/otp", new { phone = "0911111111" }));
        Assert.Equal(404, await App.Admin().Status("workspaces"));
        var (guest, _) = await GuestClient();
        var admin = App.Admin();
        admin.Cookies = new(guest.Cookies);
        Assert.Equal(401, await admin.Status("me")); // a guest session is not an organizer session
    }

    [Fact]
    public async Task One_origin_serves_both_apps()
    {
        var (admin, body, _, _) = await Staff();
        Assert.Equal("guest", (string)(await App.Guest().Call("health")).Body["app"]!);
        Assert.Equal("admin", (string)(await App.Admin().Call("health")).Body["app"]!);
        Assert.Equal("Test Workspace", (string)(await App.Guest().Call("public?tenant=" + Tenant(body))).Body["name"]!);
        var raw = App.Raw();
        foreach (var (path, marker) in new[] { ("/admin/signin", "src/admin"), ("/", "src/guest"), ("/concerts/x", "src/guest"), ("/admin", "src/admin") })
        {
            var page = await raw.GetAsync(path);
            Assert.Contains(marker, await page.Content.ReadAsStringAsync());
            Assert.Contains("frame-ancestors 'none'", page.Headers.GetValues("Content-Security-Policy").Single());
        }
        var adminPage = await raw.GetAsync("/admin");
        Assert.Contains("'sha256-", adminPage.Headers.GetValues("Content-Security-Policy").Single()); // its inline script, by hash
        Assert.Equal("nosniff", adminPage.Headers.GetValues("X-Content-Type-Options").Single());
    }

    [Fact]
    public async Task Table_qr_codes_and_public_filtering()
    {
        var (c, b, _, _) = await Staff();
        await Act(c, "event", new { name = "Concert", description = "Live show", date = "2026-11-02T18:00", venue = "Hall", price = "10.50", capacity = 100, published = false });
        var e = (await State(c))["events"]![0]!;
        var t = Tenant(b);
        var g = App.Guest();
        Assert.Empty((await g.Call("public?tenant=" + t)).Body["events"]!.AsArray());
        await Act(c, "table", new { name = "Table 1", @event = (string)e["id"]!, seats = 4 });
        await Act(c, "table", new { name = "Table 2", @event = (string)e["id"]!, seats = 4 });
        var tables = (await State(c))["tables"]!.AsArray();
        Assert.NotEqual((string)tables[0]!["token"]!, (string)tables[1]!["token"]!);
        Assert.NotEqual((string)tables[0]!["code"]!, (string)tables[1]!["code"]!);
        var pub = (await g.Call($"public?tenant={t}&table={tables[0]!["token"]}")).Body;
        Assert.Equal("Table 1", (string)pub["table"]!["name"]!);
        Assert.Equal((string)tables[1]!["token"]!, (string)(await g.Call($"table?tenant={t}&code={((string)tables[1]!["code"]!).ToLowerInvariant()}")).Body["token"]!);
        Assert.Equal(404, await g.Status($"public?tenant={t}&table=wrong"));
    }

    [Fact]
    public async Task Table_tokens_stay_stable_and_bound_to_their_concert()
    {
        var (c, _, _, _) = await Staff();
        var e = await Concert(c, 2, "10.50");
        for (var n = 0; n < 2; n++) await Act(c, "table", new { name = $"Table {n}", @event = (string)e["id"]!, seats = 4 });
        var t = (await State(c))["tables"]![0]!.AsObject();
        var renamed = t.DeepClone().AsObject();
        renamed["name"] = "Renamed";
        Assert.Equal(200, (await Act(c, "table", renamed)).Status);
        var after = (await State(c))["tables"]![0]!;
        Assert.Equal(((string)t["token"]!, (string)t["code"]!), ((string)after["token"]!, (string)after["code"]!));
        var moved = t.DeepClone().AsObject();
        moved["event"] = "other";
        Assert.Equal(400, (await Act(c, "table", moved)).Status);
    }

    [Fact]
    public async Task Roles_invites_and_member_removal()
    {
        var (c, _, _, _) = await Staff();
        var mail = Guid.NewGuid().ToString("N")[..8] + "@example.com";
        var token = ((string)(await c.Call("invite", new { email = mail, role = "Service" })).Body["url"]!).Split("invite=")[1];
        var svc = App.Admin();
        var (status, body) = await svc.Call("signup", new { name = "Service Staff", email = mail, password = Password(), invite = token });
        Assert.Equal(201, status);
        Assert.Equal(401, await svc.Status("action", new { op = "settings", version = 0, data = new { } })); // Service may not change settings
        Assert.Equal(401, await svc.Status("team/remove", new { id = (string)body["user"]!["id"]! }));     // only the Owner removes members
        Assert.Equal(401, await svc.Status("invite", new { email = "x@example.com", role = "Admin" }));   // only Owner/Admin invite
        Assert.Equal(401, await svc.Status("upload", new { data = Png }));                                  // only Owner/Admin upload
        Assert.Equal(200, await c.Status("team/remove", new { id = (string)body["user"]!["id"]! }));
        Assert.Equal(401, await svc.Status("me"));
        // The invitation was used up.
        Assert.Equal(400, await App.Admin().Status("signup", new { name = "Again", email = mail, password = Password(), invite = token }));
    }

    [Fact]
    public async Task Gate_staff_can_only_check_guests_in()
    {
        var (c, _, _, _) = await Staff();
        var mail = Guid.NewGuid().ToString("N")[..8] + "@example.com";
        var token = ((string)(await c.Call("invite", new { email = mail, role = "Gate" })).Body["url"]!).Split("invite=")[1];
        var gate = App.Admin();
        Assert.Equal(201, await gate.Status("signup", new { name = "Door", email = mail, password = Password(), invite = token }));
        Assert.Equal(401, (await Act(gate, "settle", new { id = "x" })).Status);
        Assert.Equal(400, (await Act(gate, "checkin_ticket", new { code = "EN-NONE" })).Status); // allowed, but no such ticket
    }

    [Fact]
    public async Task Payment_cannot_be_forged()
    {
        var (c, b, _, _) = await Staff();
        var (status, body) = await App.Guest().Call("checkout", new { tenant = Tenant(b), kind = "booking", paid = true, total = 1 });
        Assert.Equal((503, "PAYMENT_NOT_CONFIGURED"), (status, (string)body["code"]!));
        var state = await State(c);
        Assert.Empty(state["orders"]!.AsArray());
        Assert.Empty(state["bookings"]!.AsArray());
    }

    [Fact]
    public async Task Csrf_origin_and_upload_validation()
    {
        var (c, _, _, _) = await Staff();
        Assert.Equal(401, await c.Status("profile", new { name = "Altered" }, "https://attacker.invalid"));
        Assert.Equal(400, await c.Status("upload", new { data = "PHNjcmlwdD4=" })); // "<script>" is not an image
    }

    [Fact]
    public async Task Requests_must_be_json_objects()
    {
        Assert.Equal(400, await App.Admin().Status("signup", new JsonArray()));
        Assert.Equal(400, await App.Guest().Status("guest/otp", new JsonArray()));
        var raw = App.Raw();
        var text = await raw.PostAsync("/api/guest/otp", new StringContent("phone=1", System.Text.Encoding.UTF8, "application/x-www-form-urlencoded"));
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, text.StatusCode);
        var empty = await raw.PostAsync("/api/guest/otp", new ByteArrayContent([]));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, empty.StatusCode);
    }

    [Fact]
    public async Task Profile_avatar_and_uploaded_images()
    {
        var (c, _, _, _) = await Staff();
        var (_, uploaded) = await c.Call("upload", new { data = Png });
        var url = (string)uploaded["url"]!;
        Assert.Equal(400, await c.Status("profile", new { name = "Pic Owner", avatar = "https://evil.example/x.png" }));
        var body = (await c.Call("profile", new { name = "Pic Owner", avatar = url })).Body;
        Assert.Equal((url, url), ((string)body["user"]!["avatar"]!, (string)body["team"]![0]!["avatar"]!));
        Assert.Equal(url, (string)(await c.Call("profile", new { name = "Pic Owner" })).Body["user"]!["avatar"]!); // unchanged when omitted
        Assert.Equal(200, (await Act(c, "config", new { group = "profile", values = new { city = "Addis Ababa", address = "", mapUrl = "", photos = Enumerable.Repeat(url, 40) } })).Status);
        var image = await App.Raw().GetAsync(url);
        Assert.Equal("image/png", image.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Convert.FromBase64String(Png), await image.Content.ReadAsByteArrayAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await App.Raw().GetAsync("/uploads/missing.png")).StatusCode);
    }

    [Fact]
    public async Task Foreign_catalog_ids_are_refused()
    {
        var (c, _, _, _) = await Staff();
        var e = await Concert(c, 2, "10.50");
        var (other, _, _, _) = await Staff();
        Assert.Equal(400, (await Act(other, "event", e)).Status);
        Assert.Equal(400, (await Act(other, "menu", new { name = "X", description = "X", price = "1", category = "X", available = true, events = new[] { (string)e["id"]! } })).Status);
        Assert.Empty((await State(other))["events"]!.AsArray());
    }

    [Fact]
    public async Task Profile_password_change_ends_every_session()
    {
        var (c, _, mail, pw) = await Staff();
        Assert.Equal("Updated", (string)(await c.Call("profile", new { name = "Updated" })).Body["user"]!["name"]!);
        var second = App.Admin();
        Assert.Equal(200, await second.Status("signin", new { email = mail, password = pw }));
        var fresh = Password();
        var stale = new Dictionary<string, string>(c.Cookies);
        Assert.Equal(200, await c.Status("password", new { current = pw, password = fresh }));
        c.Cookies = stale;
        Assert.Equal(401, await c.Status("me"));
        Assert.Equal(401, await second.Status("me"));
        Assert.Equal(200, await App.Admin().Status("signin", new { email = mail, password = fresh }));
    }

    [Fact]
    public async Task Settings_are_validated_and_enforced()
    {
        var (c, b, _, _) = await Staff();
        var t = Tenant(b);
        Assert.Equal(400, (await Act(c, "config", new { group = "theme", values = new { accent = "#FFEEEE", mode = "dark" } })).Status);
        Assert.Equal(400, (await Act(c, "config", new { group = "theme", values = new { accent = "#1A4DB3", mode = "dark", adminMode = "dusk" } })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "theme", values = new { accent = "#1A4DB3", mode = "dark", adminMode = "dark" } })).Status);
        Assert.Equal(400, (await Act(c, "config", new { group = "ordering", values = new { enabled = true, requireScan = false, ticketHoldersOnly = true } })).Status);
        Assert.Equal(200, (await Act(c, "config", new { group = "support", values = new { email = "help@example.com", faq = new[] { new { q = "Parking?", a = "Free." } } } })).Status);
        await Act(c, "config", new { group = "legal", values = new { terms = "Be kind.", privacy = "" } });
        var pub = (await App.Guest().Call("public?tenant=" + t)).Body;
        Assert.Equal("""{"accent":"#1A4DB3","mode":"dark","adminMode":"dark","logo":"","cover":""}""", pub["settings"]!["theme"]!.ToJsonString());
        Assert.Equal("Parking?", (string)pub["settings"]!["support"]!["faq"]![0]!["q"]!);
        Assert.Equal("Be kind.", (string)pub["settings"]!["legal"]!["terms"]!);
        var e = await Concert(c);
        var (g, _) = await GuestClient();
        await Act(c, "config", new { group = "ticketing", values = new { enabled = true, maxPerOrder = 2 } });
        Assert.Contains("up to 2", (string)(await g.Call("quote", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 3 })).Body["error"]!);
        await Act(c, "config", new { group = "ticketing", values = new { enabled = false, maxPerOrder = 2 } });
        Assert.Contains("closed", (string)(await g.Call("quote", new { tenant = t, kind = "booking", @event = (string)e["id"]!, qty = 1 })).Body["error"]!);
    }

    [Fact]
    public async Task Head_robots_and_gzip()
    {
        var raw = App.Raw();
        var head = await raw.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/api/health"));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        Assert.True(head.Content.Headers.ContentLength > 0);
        Assert.Contains("Disallow: /admin", await raw.GetStringAsync("/robots.txt"));
        var request = new HttpRequestMessage(HttpMethod.Get, "/assets/app.js");
        request.Headers.AcceptEncoding.ParseAdd("gzip");
        var packed = await raw.SendAsync(request);
        Assert.Equal("gzip", packed.Content.Headers.ContentEncoding.Single());
        Assert.Contains("immutable", packed.Headers.CacheControl!.ToString());
        Assert.Equal(404, await App.Guest().Status("no-such-endpoint"));
        Assert.Equal(404, await App.Admin().Status("no-such-endpoint", new { }));
    }
}
