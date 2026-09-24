using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;

namespace Encore.Api.Tests;

/// <summary>Workspace rules without HTTP: stock, waiters, store inventory, cash settlement, document upgrades.</summary>
public sealed class DomainRuleTests
{
    private readonly Workspace s;

    public DomainRuleTests()
    {
        s = WorkspaceRules.Upgrade(WorkspaceRules.Blank("Concert Team"));
        s.Settings["ordering"]!["requireScan"] = false;
        s.Settings["ordering"]!["ticketHoldersOnly"] = false;
        s.Settings["payments"]!["ticketCash"] = true;
        s.Menu.Add(Obj("""{"id":"food","name":"Meal","price":10000,"available":true,"events":[]}"""));
        s.Events.Add(Obj("""{"id":"event","name":"Concert","price":50000,"published":true,"capacity":2,"date":"2026-11-02T18:00"}"""));
        s.Tables.Add(Obj("""{"id":"t","token":"unique-table","code":"ABCDEF","name":"Table 8","event":"event","seats":4,"status":"Available"}"""));
    }

    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static readonly JsonObject Guest = Obj("""{"id":"g1","name":"Guest","phone":"+251911000000"}""");

    private void Do(string op, string json) => Actions.Mutate(s, op, Obj(json), []);

    private string Refused(Action action) => Assert.Throws<DomainException>(action).Message;

    [Fact]
    public void Existing_workspaces_switch_to_vat_added_on_top_once()
    {
        var old = WorkspaceRules.Blank("Old");
        old.Settings["tax"] = Obj("""{"regime":"vat","vatRate":15,"pricesIncludeTax":true,"tin":"","vatNumber":"","tickets":true,"menu":true}""");
        var tax = WorkspaceRules.Upgrade(old).Settings["tax"]!;
        Assert.Equal((false, true), ((bool)tax["pricesIncludeTax"]!, (bool)tax["addedOnTop"]!));
        tax["pricesIncludeTax"] = true; // an organizer who later chooses VAT-inclusive prices keeps that choice
        Assert.True((bool)WorkspaceRules.Upgrade(old).Settings["tax"]!["pricesIncludeTax"]!);
    }

    [Fact]
    public void Service_charge_settings_follow_the_chosen_mode()
    {
        SettingsRules.Configure(s, "service", Obj("""{"mode":"service","rate":12.5}"""));
        Assert.False((bool)s.Settings["tips"]!["enabled"]!);
        Assert.Throws<DomainException>(() => Pricing.QuoteOrder(s, Obj("""{"kind":"menu","items":{"food":1},"tipAmount":"5"}""")));
        Assert.Null(Pricing.QuoteOrder(s, Obj("""{"kind":"booking","event":"event","qty":1}"""))["service"]); // tickets never carry one
        Assert.Throws<DomainException>(() => SettingsRules.Configure(s, "service", Obj("""{"mode":"service","rate":0}""")));
        SettingsRules.Configure(s, "service", Obj("""{"mode":"none","rate":10}"""));
        Assert.Equal(11500, Values.Long(Pricing.QuoteOrder(s, Obj("""{"kind":"menu","items":{"food":1}}"""))["total"]));
    }

    [Fact]
    public void Stock_blocks_overselling_and_cancelling_restores_it()
    {
        Do("menu", """{"id":"food","name":"Meal","description":"Hot","price":"100","category":"Food","available":true,"trackStock":true,"stock":3,"lowStock":1}""");
        var rec = Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":2}}"""), Guest, cash: true);
        Assert.Equal((false, "cash"), ((bool)rec["paid"]!, (string)rec["settlement"]!));
        Assert.Equal(1, Values.Long(s.Menu[0]["stock"]));
        Assert.Equal(1, Values.Long(WorkspaceRules.PublicState(s)["menu"]![0]!["left"]));
        Assert.Equal("Only 1 Meal left.", Refused(() => Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":2}}"""), Guest, cash: true)));
        Assert.Equal(1, Values.Long(s.Menu[0]["stock"]));
        Do("stock", """{"id":"food","mode":"add","qty":10,"reason":"Delivery"}""");
        Do("stock", """{"id":"food","mode":"remove","qty":1,"reason":"Dropped"}""");
        Do("stock", """{"id":"food","mode":"set","qty":0}""");
        Assert.True((bool)WorkspaceRules.PublicState(s)["menu"]![0]!["soldOut"]!);
        Refused(() => Do("stock", """{"id":"food","mode":"remove","qty":1}"""));
        Do("stock", """{"id":"food","mode":"add","qty":2}""");
        var staff = Obj("""{"items":{"food":2},"tableId":"t","method":"","_by":"Sara"}""");
        Actions.Mutate(s, "staff_order", staff, []);
        Assert.Equal(0, Values.Long(s.Menu[0]["stock"]));
        var unpaid = s.Orders.First(o => (string)o["ref"]! == (string)staff["result"]!["ref"]!);
        Actions.Mutate(s, "cancel", Obj($$"""{"id":"{{unpaid["id"]}}","_by":"Sara"}"""), []);
        Assert.Equal(2, Values.Long(s.Menu[0]["stock"]));
        Assert.Equal($"Cancelled {unpaid["ref"]}", (string)s.StockLog[^1]["reason"]!);
        Assert.Equal("Opening count", (string)s.StockLog[0]["reason"]!);
        Assert.Equal([3, 1, 11, 10, 0, 2, 0, 2], s.StockLog.Select(x => Values.Long(x["after"])));
    }

    [Fact]
    public void Waiter_numbers_tips_and_cash_orders()
    {
        foreach (var name in new[] { "Abel Tesfaye", "Sara Bekele", "Old Waiter" }) Do("waiter", $$"""{"name":"{{name}}"}""");
        var numbers = s.Waiters.Select(w => (string)w["number"]!).ToList();
        Assert.Equal(3, numbers.Distinct().Count());
        Assert.All(numbers, n => Assert.Matches(@"^[1-9]\d{3}$", n));
        var old = s.Waiters[2];
        Do("waiter", $$"""{"id":"{{old["id"]}}","name":"{{old["name"]}}","active":false}""");
        Assert.True((bool)WorkspaceRules.PublicState(s)["waiters"]!);
        Assert.Contains("could not find a waiter", Refused(() => Pricing.QuoteOrder(s, Obj($$"""{"kind":"menu","items":{"food":1},"waiter":"{{old["number"]}}"}"""))));
        var abel = s.Waiters[0];
        var q = Pricing.QuoteOrder(s, Obj($$"""{"kind":"menu","items":{"food":1},"tipAmount":"20","waiter":"#{{abel["number"]}}"}"""));
        Assert.Equal($$"""{"id":"{{abel["id"]}}","name":"Abel","number":"{{abel["number"]}}"}""", q["waiter"]!.ToJsonString());
        var rec = Actions.GuestRecord(s, Obj($$"""{"kind":"menu","items":{"food":1},"tipAmount":"20","waiter":"{{abel["number"]}}"}"""), Guest, cash: true);
        Assert.Equal(((string)abel["id"]!, "Abel Tesfaye", 2000L), ((string)rec["waiter"]!, (string)rec["waiterName"]!, Values.Long(rec["tip"])));
        Assert.Null(WorkspaceRules.Receipt(s, rec)["waiter"]); // the internal id stays private; name and number are shown
        var data = $$"""{"items":{"food":2},"tableId":"t","waiter":"{{abel["number"]}}","tipAmount":"10","method":"Cash","name":"Table guest","_by":"Sara"}""";
        Do("staff_order", data);
        var o = s.Orders[^1];
        Assert.Equal((true, "Cash", "Sara", (string)abel["number"]!, 20000L + 3000 + 1000, "Table 8"),
            ((bool)o["paid"]!, (string)o["settledBy"]!, (string)o["takenBy"]!, (string)o["waiterNumber"]!, Values.Long(o["total"]), (string)o["tableName"]!));
        Refused(() => Do("staff_order", data.Replace("\"Cash\"", "\"Bank transfer\"")));
        Assert.Contains("has orders", Refused(() => Do("delete", $$"""{"kind":"waiter","id":"{{abel["id"]}}"}""")));
        var before = (string)abel["number"]!;
        Do("waiter", $$"""{"id":"{{abel["id"]}}","name":"{{abel["name"]}}","regenerate":true}""");
        Assert.NotEqual(before, (string)s.Waiters[0]["number"]!);
        Refused(() => Do("settle", $$"""{"id":"{{s.Orders[0]["id"]}}","method":"Bank transfer"}"""));
    }

    [Fact]
    public void Store_inventory_with_units()
    {
        Do("inventory", """{"name":"St. George beer","category":"Alcohol","unit":"bottles","quantity":48,"reorderLevel":24,"cost":"45.50","supplier":"BGI","_by":"Owner"}""");
        Do("inventory", """{"name":"Beef","category":"Meat","unit":"kg","quantity":"12.5","reorderLevel":5,"cost":"800"}""");
        JsonObject Beer() => s.Inventory.First(i => (string)i["name"]! == "St. George beer");
        JsonObject Beef() => s.Inventory.First(i => (string)i["name"]! == "Beef");
        Assert.Equal((48.0, 4550L, 12.5), (Values.Double(Beer()["quantity"]), Values.Long(Beer()["cost"]), Values.Double(Beef()["quantity"])));
        Assert.Contains("already in your store", Refused(() => Do("inventory", """{"name":"beef","category":"Meat","unit":"kg"}""")));
        Refused(() => Do("inventory", """{"name":"Bread","category":"Bakery","unit":"spoons"}"""));
        Do("inventory_adjust", $$"""{"id":"{{Beef()["id"]}}","mode":"use","qty":"2.25","note":"Tibs"}""");
        Do("inventory_adjust", $$"""{"id":"{{Beer()["id"]}}","mode":"add","qty":24,"cost":"47"}""");
        Do("inventory_adjust", $$"""{"id":"{{Beer()["id"]}}","mode":"waste","qty":2}""");
        Assert.Contains("Only 70 bottles", Refused(() => Do("inventory_adjust", $$"""{"id":"{{Beer()["id"]}}","mode":"use","qty":71}""")));
        Do("inventory_adjust", $$"""{"id":"{{Beef()["id"]}}","mode":"set","qty":10}""");
        Assert.Equal((70.0, 4700L, 10.0), (Values.Double(Beer()["quantity"]), Values.Long(Beer()["cost"]), Values.Double(Beef()["quantity"])));
        var log = s.StockLog.Where(x => Values.Truthy(x["store"])).ToList();
        Assert.Equal(
            [("St. George beer", 48.0, 48.0), ("Beef", 12.5, 12.5), ("Beef", -2.25, 10.25), ("St. George beer", 24.0, 72.0), ("St. George beer", -2.0, 70.0), ("Beef", -0.25, 10.0)],
            log.Select(x => ((string)x["name"]!, Values.Double(x["change"]), Values.Double(x["after"]))));
        Assert.Equal("Used in kitchen/bar · Tibs", (string)log[2]["reason"]!);
        SettingsRules.Configure(s, "store", Obj("""{"categories":["Beverages","Meat","Spices"],"renames":{"Alcohol":"Beverages"}}"""));
        Assert.Equal("Beverages", (string)Beer()["category"]!);
        Do("inventory", """{"name":"Berbere","category":"Spices","unit":"kg","quantity":2}""");
        Assert.Contains("Move stock items out of Meat", Refused(() => SettingsRules.Configure(s, "store", Obj("""{"categories":["Beverages","Spices"]}"""))));
        Do("delete", $$"""{"kind":"inventory","id":"{{Beef()["id"]}}"}""");
        Assert.Equal(["St. George beer", "Berbere"], s.Inventory.Select(i => (string)i["name"]!));
    }

    [Fact]
    public void Guests_choose_cash_and_staff_record_the_payment()
    {
        var rec = Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":1},"tipAmount":"10"}"""), Guest, cash: true);
        Assert.Equal((false, "cash", 12500L), ((bool)rec["paid"]!, (string)rec["settlement"]!, Values.Long(rec["total"])));
        SettingsRules.Configure(s, "payments", Obj("""{"cash":true,"ticketCash":false}"""));
        Assert.Contains("online payment for tickets", Refused(() => Actions.GuestRecord(s, Obj("""{"kind":"booking","event":"event","qty":1}"""), Guest, cash: true)));
        Do("settle", $$"""{"id":"{{rec["id"]}}","method":"Cash"}""");
        Assert.Equal((true, "Cash"), ((bool)rec["paid"]!, (string)rec["settledBy"]!));
        SettingsRules.Configure(s, "payments", Obj("""{"cash":false,"ticketCash":false}"""));
        Assert.Contains("only accepts online payment", Refused(() => Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":1}}"""), Guest, cash: true)));
        Assert.Contains("paid online only", Refused(() => Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":1}}"""), Guest, cash: false)));
    }

    [Fact]
    public void Moving_a_delivered_order_is_refused_clearly()
    {
        var rec = Actions.GuestRecord(s, Obj("""{"kind":"menu","items":{"food":1}}"""), Guest, cash: true);
        foreach (var next in new[] { "Preparing", "Ready", "Delivered" }) Do("order_status", $$"""{"id":"{{rec["id"]}}","status":"{{next}}"}""");
        // The Python server crashed here ("Invalid request."); the port explains.
        Assert.Equal("This order cannot move to that status.", Refused(() => Do("order_status", $$"""{"id":"{{rec["id"]}}"}""")));
    }

    [Fact]
    public void Rate_limiter_counts_a_sliding_window()
    {
        var limiter = new Services.RateLimiter(new Web.EncoreOptions
        {
            Production = false, AdminOrigin = "", GuestOrigin = "", TrustProxy = false, TestMode = false, DataDir = "", WebRoot = "", DatabaseUrl = "",
        });
        var key = Guid.NewGuid().ToString();
        Assert.All(Enumerable.Range(0, 3), _ => Assert.False(limiter.Limited(key, 3, 60)));
        Assert.True(limiter.Limited(key, 3, 60));
        Assert.False(limiter.Limited(key + "other", 3, 60));
    }
}
